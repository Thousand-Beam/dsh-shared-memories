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
 *   { "v":1, "lc":42, "seq":17, "at":1730000000000, "device":"dev_xxx",
 *     "op":"version.open", ...op 私有字段 }
 *   `lc`（Lamport 逻辑时钟）是跨设备因果排序键：open() 时对齐所有设备的水位，
 *   append 时本地单调递增，不依赖墙钟（旧记录缺 lc 字段，按墙钟回退排序）。
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
  | 'entity.merge'
  | 'version.open'
  | 'version.close'
  | 'version.emotion'
  | 'pitfall.record'
  | 'pitfall.promote'
  | 'persona.shift'
  | 'quarantine.add'
  | 'quarantine.approve'
  | 'quarantine.destroy'
  | 'memory.forget'
  | 'skill.bind'
  | 'skill.unbind'
  | 'user_profile.set'
  | 'persona.bind'
  | 'persona.update'
  | 'journal.truncate'

/** 磁盘上的完整记录（含信封字段）。 */
export interface JournalRecord {
  readonly v: number
  readonly seq: number
  readonly at: number
  readonly device: string
  /**
   * Lamport 逻辑时钟：跨设备因果排序键，不依赖墙钟。
   * 旧记录（v0.3.2 及之前）无此字段，readMerged 回退用 0 + 墙钟排序。
   */
  readonly lc?: number
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
  /** Lamport 逻辑时钟：本进程已分配的最大 lc（open() 时对齐全局水位）。 */
  #lc = 0
  /** 是否已从磁盘恢复过 seq/lc。 */
  #loaded = false
  /** append 串行队列：保证"读 seq → 加一 → 写盘"不被并发打断。 */
  #queue: Promise<void> = Promise.resolve()
  /** 写闸门：快照 capture→commit 期间上锁，暂停新 append（防止 manifest sha 与磁盘内容脱节）。 */
  #gate: Promise<void> = Promise.resolve()
  /** 闸门互斥锁：同一时刻只允许一个 withGate 在跑（purge 改 journal vs 快照 capture 互斥）。 */
  #mutex: Promise<void> = Promise.resolve()
  /** 防重入标志：withGate 里再调 withGate 会死锁（#mutex 已被自己占用），直接抛错。 */
  #inGate = false

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
    // 恢复本设备 seq：从最新文件往前找最后一个可解析记录。
    const files = await this.#listFiles(this.#deviceId)
    for (const file of files.reverse()) {
      const last = await this.#readLastRecord(file)
      if (last) {
        this.#seq = Math.max(this.#seq, last.seq)
        break
      }
    }
    await this.#realignClock()
    this.#loaded = true
  }

  /**
   * 重新对齐 Lamport 逻辑时钟到所有设备最后一条记录的最大 lc。
   *
   * 冷启动 `restoreOnBoot()` pull 到远端记录后必须调一次：`open()` 时对齐的是
   * 本地磁盘水位，pull 回来的远端记录可能带更高的 lc，不对齐的话本设备接下来
   * 写的新事件 lc 会低于远端，readMerged 排序时就被排到远端之前（乱序/复活）。
   */
  async realignClock(): Promise<void> {
    await this.#realignClock()
  }

  async #realignClock(): Promise<void> {
    // 取所有设备最后一条记录的 lc 最大值。
    // 这样 pull 到远端记录后，本设备新事件会接在远端之后，跨设备因果单调。
    const devices = await this.#listDevices()
    for (const device of devices) {
      const dfiles = await this.#listFiles(device)
      for (const file of dfiles.reverse()) {
        const last = await this.#readLastRecord(file)
        if (last) {
          this.#lc = Math.max(this.#lc, typeof last.lc === 'number' ? last.lc : 0)
          break
        }
      }
    }
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
   * 写闸门：在 `fn` 执行期间暂停所有新 append（快照 capture→commit 的原子窗口）。
   * 调用方应先在外部 `await flush()` 让已排队写入落盘，再进入闸门；闸门释放后
   * 被阻塞的 append 会按进入顺序继续落盘。
   */
  async withGate<T>(fn: () => Promise<T>): Promise<T> {
    // 运行时断言：TS 类型能挡住绝大多数误用，但插件的 fn 可能来自宿主注入的动态值，
    // 在边界上再挡一道，避免 undefined() 之类的诡异崩溃。
    if (typeof fn !== 'function') {
      throw new TypeError('journal.withGate(fn): fn 必须是函数')
    }
    // 防重入：withGate 里再调 withGate 会拿不到 #mutex（被自己占着）而永远挂起。
    if (this.#inGate) {
      throw new Error('journal.withGate() 不允许嵌套调用：外层闸门尚未释放')
    }
    this.#inGate = true
    // 等所有已排队的写入落盘，避免闸门内还有半截 append 在飞。
    await this.#queue
    // 互斥：同一时刻只允许一个 withGate 在跑。purge 会原子重写 journal 文件，
    // 快照 capture 也在读这些文件算 sha256，两者并发会算出与磁盘脱节的 manifest。
    const prev = this.#mutex
    let releaseMutex!: () => void
    this.#mutex = new Promise((resolve) => {
      releaseMutex = resolve
    })
    await prev
    let release!: () => void
    this.#gate = new Promise((resolve) => {
      release = resolve
    })
    try {
      return await fn()
    } finally {
      release()
      releaseMutex()
      this.#inGate = false
    }
  }

  /**
   * 按设备顺序读取增量记录（seq > sinceSeq）。
   * 用于单设备回放；多设备合并请用 `readMerged()`。
   */
  async *readDevice(deviceId: string, sinceSeq = 0): AsyncGenerator<JournalRecord> {
    const files = await this.#listFiles(deviceId)
    for (const file of files) {
      for await (const record of this.#iterate(file)) {
        if (record.seq > sinceSeq) {
          // 旧版墓碑（2026-11-18 之前）写成 `deviceId` 而不是 `device`，且缺 `v`。
          // 这里按目录名兜底补 `device`，保证 readMerged 的 (at, device, seq) 排序
          // 不会因为 undefined.device 崩溃，也让任何读路径拿到一致的设备字段。
          yield typeof record.device === 'string' ? record : { ...record, device: deviceId }
        }
      }
    }
  }

  /**
   * 读取所有设备的记录并按**因果顺序**合并排序。
   *
   * 排序键：`(lc, at, device, seq)`。lc（Lamport 逻辑时钟）优先，因为两台设备的
   * 墙钟可能漂移，但 lc 在每次 pull 到远端记录后都会对齐到远端水位之上，跨设备
   * 因果有序（墓碑先于其后写入的复活记录）。旧记录无 lc 字段时回退按墙钟排序。
   * 量级提示：这是全量读入内存的接口，仅用于恢复/整理这类低频路径。
   *
   * `sinceSeq` 是 checkpoint 水位（每设备）：`seq <= sinceSeq[device]` 的事件已经
   * 体现在快照的 memory.db 里，恢复时跳过它们、只重放增量，避免冷启动线性变慢。
   * 省略或某设备缺水位时，该设备按全量读（安全回退）。
   */
  async readMerged(options: { sinceAt?: number; sinceSeq?: Readonly<Record<string, number>> } = {}): Promise<JournalRecord[]> {
    const sinceAt = options.sinceAt ?? 0
    const sinceSeq = options.sinceSeq
    const devices = await this.#listDevices()
    const out: JournalRecord[] = []
    for (const device of devices) {
      const floor = sinceSeq?.[device] ?? 0
      for await (const record of this.readDevice(device, floor)) {
        if (record.at >= sinceAt) out.push(record)
      }
    }

    // D-03：rollback 截断墓碑。`journal.truncate`（rollback 时本机追加）标记「该设备
    // 在回退点的 seq 高水位（floor）」。真正要丢弃的只有「回退点之后、墓碑写入之前」
    // 这一窗口（floor < seq ≤ 墓碑自身 seq）；墓碑之后（seq > 墓碑 seq）是本机在回退后
    // 新写的记录，必须保留，否则 rollback 会成为该设备的永久写黑洞。journal 按 UTC 日期
    // 分片，回退点之后跨天写出的新分片是 untracked 文件，`git checkout <tag> -- .` 不会删
    // 它，只能靠墓碑在重放层截断。按 device 维度生效（本机回退本机的）；多次回退取
    // 「seq 最大（即最后写入）的那条墓碑」的水位，语义上「回退到更早快照」覆盖「回退到
    // 更晚快照」。
    const truncateFloor = new Map<string, { seq: number; floor: number }>()
    for (const record of out) {
      if (record.op !== 'journal.truncate') continue
      const floor = typeof record.truncateSeq === 'number' ? record.truncateSeq : -1
      if (floor < 0) continue
      const device = typeof record.device === 'string' ? record.device : ''
      const prev = truncateFloor.get(device)
      if (!prev || record.seq > prev.seq) {
        truncateFloor.set(device, { seq: record.seq, floor })
      }
    }
    const visible = truncateFloor.size > 0
      ? out.filter((record) => {
          if (record.op === 'journal.truncate') return true // 墓碑保留，apply 层走 default 只统计
          const device = typeof record.device === 'string' ? record.device : ''
          const cut = truncateFloor.get(device)
          // 保留快照水位（≤ floor）与墓碑之后的新写（> 墓碑 seq），只滤掉中间的窗口。
          return cut === undefined || record.seq <= cut.floor || record.seq > cut.seq
        })
      : out

    visible.sort((a, b) => {
      const la = typeof a.lc === 'number' ? a.lc : 0
      const lb = typeof b.lc === 'number' ? b.lc : 0
      return la - lb || a.at - b.at || a.device.localeCompare(b.device) || a.seq - b.seq
    })
    return visible
  }

  /** 列出所有写入过日志的设备（用于多端合并与冲突面板）。 */
  async listDevices(): Promise<string[]> {
    return this.#listDevices()
  }

  // ── 内部实现 ────────────────────────────────────────────────────────────

  async #appendOne(input: JournalInput): Promise<JournalRecord> {
    if (!this.#loaded) await this.open()
    // 快照写闸门：capture→commit 期间新 append 挂起，保证 manifest sha 与磁盘内容一致。
    await this.#gate
    const at = input.at ?? this.#clock()
    // 显式展开顺序：信封字段在最后，防止调用方覆盖 seq/device。
    const record: JournalRecord = {
      ...input,
      v: JOURNAL_VERSION,
      lc: ++this.#lc,
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
