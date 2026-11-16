/**
 * dsh-shared-memories — JSONL 事件日志（真相源）
 * ---------------------------------------------------------------------------
 * 架构决策回顾：**数据库不是真相，日志才是**。
 *  - 每次记忆变更先落一行 JSON（append-only），再由物化视图（SQLite / 内存索引）消费；
 *  - 冷启动时若视图损坏，删掉重建即可，日志一行不丢；
 *  - Git 只合并文本，天然可三方合并；二进制 .db 永不入库。
 *
 * 文件布局（刻意按「设备 + UTC 日期」分片）：
 *   <root>/journal/devices/<deviceId>/2026-11-16.jsonl
 *
 * 为什么按设备分片：两台机器同时写同一个文件必然产生 git 冲突；分片后
 * 每台设备只写自己的文件，git 层面几乎不会冲突，合并退化为"文件并集"。
 *
 * 记录格式（每行一条，字段稳定，向后兼容靠 `v`）：
 *   { "v":1, "seq":42, "at":1730000000000, "device":"dev_xxx",
 *     "op":"version.open", ...op 私有字段 }
 *
 * 写入保证：
 *  - 同一进程内 append 串行化（Promise 队列），不会交错半行；
 *  - `durable: true`（默认）时每次 fsync，保证"停机即快照"不会丢最后一条；
 *  - 读取容忍损坏行（手工编辑、磁盘截断），跳过并回调告警，绝不整体抛错。
 */
import { createReadStream } from 'node:fs'
import { mkdir, open, readFile, readdir } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { createInterface } from 'node:readline'

/** 日志格式版本；不兼容变更时递增，并在 replay 层做迁移。 */
export const JOURNAL_VERSION = 1

/** 已知操作类型；字符串留口子，方便后续插件扩展自定义 op。 */
export type JournalOp =
  | 'entity.upsert'
  | 'version.open'
  | 'version.close'
  | 'pitfall.promote'
  | 'persona.shift'
  | 'quarantine.add'
  | 'memory.forget'
  | 'skill.bind'
  | 'skill.unbind'
  | 'user_profile.set'
  | 'persona.bind'

/** 磁盘上的完整记录（含信封字段）。 */
export interface JournalRecord {
  readonly v: number
  readonly seq: number
  readonly at: number
  readonly device: string
  readonly op: JournalOp | string
  readonly [key: string]: unknown
}

/** 调用方要写的载荷：信封字段由 Journal 补全。 */
export type JournalInput = {
  readonly op: JournalOp | string
  /** 事件时间；缺省 = 当前墙钟。 */
  readonly at?: number
  /** 其余业务字段由各 op 自己定义，journal 只负责原样落盘。 */
  readonly [key: string]: unknown
}

export interface JournalOptions {
  /** 仓库根目录（与 Git 工作区一致）。 */
  root: string
  /** 设备 ID，必须能安全作为目录名。 */
  deviceId: string
  /** 每次 append 是否 fsync。默认 true；高频测试可关掉换速度。 */
  durable?: boolean
  /** 时钟注入，便于测试构造历史时间线。 */
  clock?: () => number
  /** 损坏行/异常告警回调。 */
  onWarn?: (message: string) => void
}

/** 设备 ID 必须能直接当目录名，杜绝路径穿越。 */
const DEVICE_ID_RE = /^[0-9A-Za-z_-]{3,64}$/

export class Journal {
  readonly #root: string
  readonly #deviceId: string
  readonly #durable: boolean
  readonly #clock: () => number
  readonly #onWarn: (message: string) => void

  /** 当前设备已分配的最大 seq。 */
  #seq = 0
  /** 是否已从磁盘恢复过 seq。 */
  #loaded = false
  /** append 串行队列：保证"读 seq → 加一 → 写盘"不被并发打断。 */
  #queue: Promise<void> = Promise.resolve()

  constructor(options: JournalOptions) {
    if (!DEVICE_ID_RE.test(options.deviceId)) {
      throw new Error(`invalid deviceId: ${options.deviceId}`)
    }
    this.#root = options.root
    this.#deviceId = options.deviceId
    this.#durable = options.durable ?? true
    this.#clock = options.clock ?? Date.now
    this.#onWarn = options.onWarn ?? (() => {})
  }

  get deviceId(): string {
    return this.#deviceId
  }

  /** 当前已分配的最大 seq（未 open 时为 0）。 */
  get lastSeq(): number {
    return this.#seq
  }

  /**
   * 从磁盘恢复 seq。必须在使用前调用一次（构造函数不做事，便于测试同步构造）。
   * 从最新的文件往前找最后一个可解析记录，避免启动时扫全量日志。
   */
  async open(): Promise<void> {
    if (this.#loaded) return
    const files = await this.#listFiles(this.#deviceId)
    for (const file of files.reverse()) {
      const last = await this.#readLastRecord(file)
      if (last) {
        this.#seq = Math.max(this.#seq, last.seq)
        break
      }
    }
    this.#loaded = true
  }

  /**
   * 追加一条记录。返回带信封字段的完整记录，调用方可据此回填内存状态。
   * 注意：**先落盘再返回**，因此 await 之后这条记忆已经可被恢复。
   */
  async append(input: JournalInput): Promise<JournalRecord> {
    const run = this.#queue.then(() => this.#appendOne(input))
    // 无论成败都推进队列，避免一次失败卡死后续所有写入。
    this.#queue = run.then(
      () => undefined,
      () => undefined,
    )
    return run
  }

  /** 等待队列中所有写入落盘（关机/手动保存前调用）。 */
  async flush(): Promise<void> {
    await this.#queue
  }

  /**
   * 按设备顺序读取增量记录（seq > sinceSeq）。
   * 用于单设备回放；多设备合并请用 `readMerged()`。
   */
  async *readDevice(deviceId: string, sinceSeq = 0): AsyncGenerator<JournalRecord> {
    const files = await this.#listFiles(deviceId)
    for (const file of files) {
      for await (const record of this.#iterate(file)) {
        if (record.seq > sinceSeq) yield record
      }
    }
  }

  /**
   * 读取所有设备的记录并按**事件时间**合并排序。
   *
   * 排序键：`(at, device, seq)`。事件时间优先，是因为两台设备的墙钟可能不同步，
   * 但同一条记忆的版本区间语义依赖 `valid_from`，回放必须按它稳定排序。
   * 量级提示：这是全量读入内存的接口，仅用于恢复/整理这类低频路径。
   */
  async readMerged(options: { sinceAt?: number } = {}): Promise<JournalRecord[]> {
    const sinceAt = options.sinceAt ?? 0
    const devices = await this.#listDevices()
    const out: JournalRecord[] = []
    for (const device of devices) {
      for await (const record of this.readDevice(device, 0)) {
        if (record.at >= sinceAt) out.push(record)
      }
    }
    out.sort((a, b) => a.at - b.at || a.device.localeCompare(b.device) || a.seq - b.seq)
    return out
  }

  /** 列出所有写入过日志的设备（用于多端合并与冲突面板）。 */
  async listDevices(): Promise<string[]> {
    return this.#listDevices()
  }

  // ── 内部实现 ────────────────────────────────────────────────────────────

  async #appendOne(input: JournalInput): Promise<JournalRecord> {
    if (!this.#loaded) await this.open()
    const at = input.at ?? this.#clock()
    // 显式展开顺序：信封字段在最后，防止调用方覆盖 seq/device。
    const record: JournalRecord = {
      ...input,
      v: JOURNAL_VERSION,
      seq: ++this.#seq,
      at,
      device: this.#deviceId,
    }
    const file = this.#fileFor(at)
    await mkdir(dirname(file), { recursive: true })
    const handle = await open(file, 'a')
    try {
      await handle.writeFile(`${JSON.stringify(record)}\n`, 'utf8')
      if (this.#durable) await handle.sync()
    } finally {
      await handle.close()
    }
    return record
  }

  /** UTC 日期分片：跨时区设备写出的文件名一致，git 合并更干净。 */
  #fileFor(at: number): string {
    const day = new Date(at).toISOString().slice(0, 10)
    return join(this.#root, 'journal', 'devices', this.#deviceId, `${day}.jsonl`)
  }

  async #listFiles(deviceId: string): Promise<string[]> {
    const dir = join(this.#root, 'journal', 'devices', deviceId)
    try {
      const names = await readdir(dir)
      return names
        .filter((name) => name.endsWith('.jsonl'))
        .sort()
        .map((name) => join(dir, name))
    } catch {
      // 目录不存在 = 从未写过日志，属于正常状态。
      return []
    }
  }

  async #listDevices(): Promise<string[]> {
    const dir = join(this.#root, 'journal', 'devices')
    try {
      const entries = await readdir(dir, { withFileTypes: true })
      return entries.filter((e) => e.isDirectory()).map((e) => e.name).sort()
    } catch {
      return []
    }
  }

  async #readLastRecord(file: string): Promise<JournalRecord | null> {
    let raw: string
    try {
      raw = await readFile(file, 'utf8')
    } catch {
      return null
    }
    const lines = raw.split('\n')
    for (let i = lines.length - 1; i >= 0; i--) {
      const line = lines[i]!.trim()
      if (!line) continue
      try {
        const record = JSON.parse(line) as JournalRecord
        if (typeof record.seq === 'number') return record
      } catch {
        this.#onWarn(`journal: 跳过损坏行 ${file}:${i + 1}`)
      }
    }
    return null
  }

  /** 逐行解析；损坏行跳过而不是中断整个回放。 */
  async *#iterate(file: string): AsyncGenerator<JournalRecord> {
    const stream = createReadStream(file, { encoding: 'utf8' })
    const reader = createInterface({ input: stream, crlfDelay: Infinity })
    let lineNo = 0
    try {
      for await (const line of reader) {
        lineNo++
        const raw = line.trim()
        if (!raw) continue
        try {
          const record = JSON.parse(raw) as JournalRecord
          if (typeof record.seq !== 'number' || typeof record.at !== 'number') {
            this.#onWarn(`journal: 字段不完整 ${file}:${lineNo}`)
            continue
          }
          yield record
        } catch {
          this.#onWarn(`journal: 无法解析 ${file}:${lineNo}`)
        }
      }
    } finally {
      reader.close()
      stream.close()
    }
  }
}
