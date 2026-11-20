/**
 * 彻底销毁（Hard Delete）：把一个人从"数据库 + 事件日志"里同时抹掉。
 *
 * 为什么不能只删库表：
 *   journal 是真相源。下次冷启动 replay 会把删掉的记忆**原样重建**回来，
 *   于是"我删了它"变成"我删了，它还在"。所以销毁必须两件事一起做：
 *
 *   ① 删库：memory_entity / version / emotion / quarantine / persona_state /
 *      persona_identity / agent_skill / session_policy / audit_log 里该 Agent 的行；
 *   ② 改写 journal：把每个 `journal/devices/<device>/*.jsonl` 里属于该 Agent 的
 *      记录**物理剔除**（不是追加删除标记），再追加一条 `agent.purge` 墓碑，
 *      保证"更早的、还留在别的设备上的快照"在 replay 时也会被清掉。
 *
 * ── 2026-11-18 加固（宿主闪退事故）─────────────────────────────────────────
 * 事故：Windows 上 `rename()` 撞到被占用的 jsonl（EBUSY/EPERM）时异常一路
 * 冒到宿主，进程直接退出，墓碑没写进去，下次开机记忆"借尸还魂"。
 * 现在这个模块的契约是：
 *   1. **不向外抛任何非业务异常**。文件 I/O 与 SQL 全部逐条兜住，
 *      失败只记进 `failures` + `onWarn`；
 *   2. 只有在"确实没删干净"时抛 `PurgeError('purge-partial')`，
 *      由 HTTP 层翻译成 4xx/5xx 给前端弹 Toast —— 宿主进程永远活着；
 *   3. 改写文件一律 **先写临时文件 → fsync → rename**，rename 失败按
 *      EBUSY/EPERM 退避重试，仍失败才退回原地覆盖，绝不先删原文件；
 *   4. 墓碑最后写、且独立兜底：即使前面全挂，也要留下"此人已销毁"的证据，
 *      让下一次 replay 有机会把残留清掉。
 *
 * 这台机器上没有幽灵副本：文件被原地重写，删完 `git grep` 也搜不到原文。
 */

import { randomUUID } from 'node:crypto'
import { mkdir, open, readFile, readdir, rename, rm, unlink, writeFile } from 'node:fs/promises'
import { basename, join } from 'node:path'

import { isSafeScopeToken } from '../../shared/scope.js'
import type { SqlDriver } from '../../shared/types.js'

export interface PurgeResult {
  readonly agentId: string
  readonly entities: number
  readonly versions: number
  readonly quarantine: number
  readonly personas: number
  readonly identities: number
  readonly skills: number
  readonly policies: number
  readonly audits: number
  /**
   * 被删掉的宿主会话日志份数（`~/.dsh/sessions/<cwd-slug>/<sessionId>`）。
   * 侧栏那一行来自会话持久化扫描，不删它，销毁完就只剩一个点不开的空壳。
   */
  readonly sessionFiles: number
  /** 被改写过的 journal 文件数（含墓碑写入的那个）。 */
  readonly journals: number
  /** 从 journal 里物理剔除的记录条数。 */
  readonly records: number
  /** 墓碑是否真的落盘。false = 下次 replay 仍可能复活，必须重跑。 */
  readonly tombstone: boolean
  /** 失败明细（人类可读）。非空时抛 `purge-partial`，但进程不会崩。 */
  readonly failures: readonly string[]
}

export interface PurgeOptions {
  readonly db: SqlDriver
  readonly root: string
  readonly workspaceId: string
  readonly agentId: string
  /**
   * 原始会话 id（前端传的 sessionId）。删库/写墓碑按 `agentId`（人格 id），
   * 但删宿主会话日志按这个 id 匹配目录名——继承型会话里目录名是 sessionId，
   * 不是人格 id，按人格 id 匹配会落空（`sessionFiles = 0`，行重启后仍在）。
   */
  readonly sessionId?: string
  readonly clock?: () => number
  readonly onWarn?: (message: string) => void
  /**
   * 宿主状态根（通常是 `~/.dsh`，也就是数据根的上一层）。
   * 给了就删掉这条会话的宿主侧日志 `sessions/<cwd-slug>/<sessionId>`——会话正文的
   * 持久化文件。删掉后宿主重启扫 header 就再也看不到这一行；运行期那一行靠前端
   * archiveSession 归档隐藏，不在这里动 workspace 记账（那会跟宿主内存态打架，
   * 把已归档会话渲染成「未分组」的「未命名」幽灵）。
   */
  readonly hostRoot?: string
}

/**
 * 销毁过程中的**业务**错误。
 *
 * 存在的唯一目的：让"文件被占用"这类事故有一个可被 HTTP 层识别的类别，
 * 而不是变成裸的 `Error: EBUSY` 一路冒到宿主顶层把进程带走。
 */
export class PurgeError extends Error {
  readonly code: string
  /** 已经完成的部分；前端可以据此显示"删了 90%，剩余会在下次开机清掉"。 */
  readonly partial: PurgeResult | undefined

  constructor(code: string, message: string, partial?: PurgeResult) {
    super(message)
    this.name = 'PurgeError'
    this.code = code
    this.partial = partial
  }
}

interface JournalRecordShape {
  readonly seq?: number
  readonly lc?: number
  readonly op?: string
  readonly workspaceId?: string
  readonly agentId?: string
  readonly entityId?: string
  readonly personaId?: string
  readonly [key: string]: unknown
}

interface PurgeJournalOptions {
  readonly root: string
  readonly workspaceId: string
  readonly agentId: string
  /**
   * 这个人格名下所有实体 id。
   *
   * 为什么不能只按 agentId 过滤：`version.open` / `version.close` 这两类记录
   * 属于实体而不是某次操作，**只带 entityId、不带 agentId**（见
   * `src/host/memory/timetree.ts` 的 `buildJournalOps`）。少了这一条，
   * 库里删干净了、journal 里还留着正文，下次 replay 全部回来。
   */
  readonly entityIds: ReadonlySet<string>
  readonly at: number
  readonly warn: (message: string) => void
  readonly failures: string[]
}

/** 可重试的 Windows 文件占用错误码。 */
const RETRYABLE_CODES = new Set(['EBUSY', 'EPERM', 'EACCES', 'EMFILE', 'ENFILE', 'EAGAIN'])
const RETRY_ATTEMPTS = 6

function messageOf(cause: unknown): string {
  if (cause instanceof Error) return cause.message
  return String(cause)
}

function codeOf(cause: unknown): string {
  const code = (cause as { code?: unknown } | null)?.code
  return typeof code === 'string' ? code : ''
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms)
  })
}

/** 对"文件被占用"这类瞬时错误做退避重试；其它错误立刻上抛给调用方兜住。 */
async function withRetry<T>(fn: () => Promise<T>): Promise<T> {
  let last: unknown
  for (let attempt = 0; attempt < RETRY_ATTEMPTS; attempt++) {
    try {
      return await fn()
    } catch (cause) {
      last = cause
      if (!RETRYABLE_CODES.has(codeOf(cause))) throw cause
      await sleep(25 * 2 ** attempt)
    }
  }
  throw last
}

async function safeUnlink(file: string): Promise<void> {
  try {
    await unlink(file)
  } catch {
    // 临时文件本来就可能不存在；删不掉也只是留个垃圾文件，不值得中断销毁。
  }
}

/** 物理销毁：库 + journal 一起清。返回真实删除的行数（不是"影响行数"的估算）。 */
export async function purgeAgent(options: PurgeOptions): Promise<PurgeResult> {
  const { db, root, workspaceId, agentId, sessionId } = options
  const warn = options.onWarn ?? (() => undefined)
  const at = (options.clock ?? (() => Date.now()))()
  const failures: string[] = []

  // 待清理的 id 集合：persona_state 行与 persona/<id>.json 的 key 既可能是人格 id
  // 也可能是会话 id（历史数据、继承路径、手动改绑），两者都要清，否则"销毁了但人格
  // 文件还在"会被下一次快照漫游到别的机器复活（P0-C）。
  const idKeys = [...new Set([agentId, sessionId].filter((v): v is string => typeof v === 'string' && v !== ''))]

  const fail = (label: string, cause: unknown): void => {
    const text = `${label}：${messageOf(cause)}`
    failures.push(text)
    warn(text)
  }

  // ── ① 删库：先取实体 id（版本表没有 workspace/agent 列，只能按 entity 删） ──
  // 读阶段也兜住：库没开、表缺列，都不该把宿主带走。
  let entities: { entity_id: string }[] = []
  try {
    entities = db.all<{ entity_id: string }>(
      'SELECT entity_id FROM memory_entity WHERE workspace_id = ? AND agent_id = ?',
      [workspaceId, agentId],
    )
  } catch (cause) {
    fail('读实体列表失败', cause)
  }

  const versions = countRows(
    db,
    'SELECT version_id FROM memory_version WHERE entity_id IN (SELECT entity_id FROM memory_entity WHERE workspace_id = ? AND agent_id = ?)',
    [workspaceId, agentId],
  )
  const quarantine = countRows(db, 'SELECT quarantine_id FROM quarantine WHERE workspace_id = ? AND agent_id = ?', [workspaceId, agentId])
  const personas = countRows(db, `SELECT agent_id FROM persona_state WHERE workspace_id = ? AND agent_id IN (${placeholders(idKeys)})`, [workspaceId, ...idKeys])
  const identities = countRows(db, `SELECT agent_id FROM persona_identity WHERE workspace_id = ? AND agent_id IN (${placeholders(idKeys)})`, [workspaceId, ...idKeys])
  const skills = countRows(db, 'SELECT skill_id FROM agent_skill WHERE workspace_id = ? AND agent_id = ?', [workspaceId, agentId])
  const policies = countRows(db, 'SELECT session_id FROM session_policy WHERE workspace_id = ? AND agent_id = ?', [workspaceId, agentId])
  const audits = countRows(db, 'SELECT audit_id FROM audit_log WHERE workspace_id = ? AND agent_id = ?', [workspaceId, agentId])

  const entityIds = new Set(entities.map((row) => row.entity_id))

  // 事务里逐条兜住：一条语句失败（表不存在、库只读）不能让整批回滚掉，
  // 更不能把异常交给宿主；残留在墓碑 replay 时会被再清一遍。
  const tx = (): void => {
    const step = (label: string, sql: string, params: readonly unknown[]): void => {
      try {
        db.run(sql, params)
      } catch (cause) {
        fail(label, cause)
      }
    }
    for (const entity of entities) {
      step('删版本', 'DELETE FROM memory_version WHERE entity_id = ?', [entity.entity_id])
    }
    step('删实体', 'DELETE FROM memory_entity WHERE workspace_id = ? AND agent_id = ?', [workspaceId, agentId])
    step('删踩坑', 'DELETE FROM pitfall WHERE workspace_id = ? AND agent_id = ?', [workspaceId, agentId])
    step('删隔离区', 'DELETE FROM quarantine WHERE workspace_id = ? AND agent_id = ?', [workspaceId, agentId])
    step('删人格状态', `DELETE FROM persona_state WHERE workspace_id = ? AND agent_id IN (${placeholders(idKeys)})`, [workspaceId, ...idKeys])
    step('删身份绑定', `DELETE FROM persona_identity WHERE workspace_id = ? AND agent_id IN (${placeholders(idKeys)})`, [workspaceId, ...idKeys])
    // 别的会话可能绑到这个人格上：一并解绑，否则"销毁了还继承"。
    step('断人格引用', `DELETE FROM persona_identity WHERE workspace_id = ? AND persona_id IN (${placeholders(idKeys)})`, [workspaceId, ...idKeys])
    step('删技能', 'DELETE FROM agent_skill WHERE workspace_id = ? AND agent_id = ?', [workspaceId, agentId])
    // 提炼水位也一起烧掉：留着会让"销毁后重开同名会话"以为已经记过了。
    step(
      '删提炼水位',
      'DELETE FROM distill_cursor WHERE session_id IN (SELECT session_id FROM session_policy WHERE workspace_id = ? AND agent_id = ?)',
      [workspaceId, agentId],
    )
    step('删会话策略', 'DELETE FROM session_policy WHERE workspace_id = ? AND agent_id = ?', [workspaceId, agentId])
    step('删审计', 'DELETE FROM audit_log WHERE workspace_id = ? AND agent_id = ?', [workspaceId, agentId])
  }
  try {
    db.transaction(tx)
  } catch (cause) {
    // 事务整体开不起来（例如 SQLITE_BUSY）——此时连逐条兜底都没跑，必须记一笔。
    fail('删库事务失败', cause)
  }

  // ── ② 改写 journal：物理剔除 + 墓碑 ──
  let journals = 0
  let records = 0
  let tombstone = false
  try {
    const purged = await purgeJournal({
      root,
      workspaceId,
      agentId,
      entityIds,
      at,
      warn,
      failures,
    })
    journals = purged.files
    records = purged.records
    tombstone = purged.tombstone
  } catch (cause) {
    // purgeJournal 自己已经全程兜底；能走到这里说明出了预期外的事，
    // 记下来继续写墓碑，绝不上抛。
    fail('改写 journal 失败', cause)
  }

  // ── ③ 派生状态文件（persona/*.json、state/*.json）──
  // 这些文件不进库、但会被快照带走；留着它们等于给"复活"留了条备胎。
  try {
    await scrubDerivedState({ root, workspaceId, agentId, sessionId, warn, failures })
  } catch (cause) {
    fail('清理派生状态失败', cause)
  }

  // ── ④ 宿主侧残留：会话日志（~/.dsh/sessions/<slug>/<sessionId>）──
  // 侧栏那一行不来自记忆库，而是宿主持久化的会话日志 + workspace 记账拼出来的。
  // 这里只删会话日志：运行期靠前端 archiveSession 归档隐藏，重启后宿主 header 索引
  // 扫不到它，行彻底消失。不碰投影缓存和 workspace.json（那是宿主持有状态，插件直接
  // 改磁盘会跟宿主内存态打架，正是 v0.3.4 修的幽灵 bug）。
  let sessionFiles = 0
  if (options.hostRoot !== undefined && options.hostRoot !== '') {
    try {
      sessionFiles = await dropHostSessionTraces({
        hostRoot: options.hostRoot,
        agentId,
        sessionId: options.sessionId,
        warn,
        failures,
      })
    } catch (cause) {
      fail('清理宿主会话痕迹失败', cause)
    }
  }

  if (!tombstone) {
    // 墓碑没写成功是最严重的一种"删了但会回来"，单独再试一次（用现场时间）。
    try {
      tombstone = await appendTombstone({ root, workspaceId, agentId, at: Math.max(at, Date.now()) })
    } catch (cause) {
      fail('补写墓碑失败', cause)
    }
  }

  const result: PurgeResult = {
    agentId,
    entities: entities.length,
    versions,
    quarantine,
    personas,
    identities,
    skills,
    policies,
    audits,
    journals,
    records,
    sessionFiles,
    tombstone,
    failures,
  }

  if (failures.length > 0) {
    // 业务错误：HTTP 层会把它翻成 4xx/5xx 的 JSON，前端弹 Toast。
    throw new PurgeError(
      'purge-partial',
      `销毁未完全成功（${failures.length} 项）：${failures.slice(0, 3).join('；')}`,
      result,
    )
  }

  return result
}

/* ── 宿主会话日志（侧栏那一行的真正来源）────────────────────────────────── */

const SESSION_NAME_PREFIX = 'session-'

/** `session-<uuid>` 与裸 `<uuid>` 是同一条会话的两种落盘命名。 */
function bareSessionId(name: string): string {
  return name.startsWith(SESSION_NAME_PREFIX) ? name.slice(SESSION_NAME_PREFIX.length) : name
}

interface DropSessionOptions {
  readonly sessionStoreRoot: string
  /** 回收区目录：放在 sessions/ 之外，宿主扫 header 不会把它当会话目录。 */
  readonly trashDir: string
  readonly agentId: string
  /** 原始会话 id（前端传的 sessionId）。继承型会话的目录名是这个，不是人格 id。 */
  readonly sessionId?: string
  readonly warn: (message: string) => void
  readonly failures: string[]
}

/**
 * 删掉 `<root>/<cwd-slug>/<sessionId>` 与 `<root>/<cwd-slug>/session-<sessionId>`。
 *
 * 只按"归一化后完全相等"匹配，绝不做前缀/模糊匹配 —— 这条路径上乱删一个目录
 * 就是用户的一整段对话没了。删除走"先 rename 到 .purge-trash 再 rm"：
 * rename 是原子的，行会立刻从下一次扫描里消失；rename 撞上占用才退化成直接删。
 *
 * `sessionId` 是前端传的会话目录名，`agentId` 是解出来的人格 id——继承型会话里
 * 两者不同（目录叫 `session-8cc2…`，人格叫 `lead`），按人格 id 匹配不到任何目录，
 * 会让「重启后行消失」落空。所以这里优先用 sessionId，缺省才回退 agentId。
 */
async function dropSessionLogs(options: DropSessionOptions): Promise<number> {
  const { sessionStoreRoot, trashDir, agentId, sessionId, warn, failures } = options
  const target = bareSessionId(sessionId ?? agentId)
  if (target === '') return 0

  let slugs: string[]
  try {
    const entries = await readdir(sessionStoreRoot, { withFileTypes: true })
    slugs = entries.filter((entry) => entry.isDirectory()).map((entry) => entry.name)
  } catch (cause) {
    // 没装过会话持久化（目录不存在）是正常情况，不该算失败。
    if (codeOf(cause) !== 'ENOENT') failures.push(`读会话目录失败：${sessionStoreRoot}：${messageOf(cause)}`)
    return 0
  }

  let removed = 0
  for (const slug of slugs) {
    if (slug === TRASH_DIR) continue
    const dir = join(sessionStoreRoot, slug)
    let names: string[]
    try {
      const entries = await readdir(dir, { withFileTypes: true })
      names = entries.map((entry) => entry.name).filter((name) => bareSessionId(name) === target)
    } catch (cause) {
      failures.push(`读会话目录失败：${dir}：${messageOf(cause)}`)
      continue
    }
    for (const name of names) {
      const full = join(dir, name)
      try {
        const { residue } = await discardIn(trashDir, full)
        removed += 1
        if (residue) {
          failures.push(`回收区残留副本未清：${full}（已移出会话目录，但 trash 里留了一份完整日志）`)
        }
      } catch (cause) {
        failures.push(`删会话日志失败：${full}：${messageOf(cause)}`)
      }
    }
  }

  if (removed > 0) warn(`已删除 ${removed} 份宿主会话日志`)
  return removed
}

const TRASH_DIR = '.purge-trash'

interface HostTraceOptions {
  readonly hostRoot: string
  readonly agentId: string
  /** 原始会话 id（前端传的 sessionId），会话目录名按它匹配，不按人格 id。 */
  readonly sessionId?: string
  readonly warn: (message: string) => void
  readonly failures: string[]
}

/**
 * 宿主侧痕迹：只删会话日志（`~/.dsh/sessions/<slug>/<sessionId>`）。
 *
 * 不再删投影缓存和 workspace 记账（曾经删过，真机踩坑回退）：
 * - `storages/workspace.json` 由宿主 workspace registry 独占持久化，插件直接改磁盘
 *   会跟宿主内存态打架：侧栏把已归档会话当成「找不到 workspace」的 stray 行，
 *   掉进「未分组」，渲染成「未命名」幽灵（时间还是几天前）。
 * - `storages/session_projcache/sessions/<id>.json` 是侧栏标题投影，删了就没标题，
 *   同样变「未命名」。
 *
 * 让行真正消失是两段式：
 *   运行期 → 前端 archiveSession 归档（宿主原生机制，行从默认分组隐藏）；
 *   重启后 → 这里删掉的会话日志让宿主 header 索引扫不到，行彻底不再出现。
 * 归档在前、删日志在后（purge 处理器就是这顺序），archiveSession 的 sessionKnown
 * 校验时日志还在，不会被「会话不存在」拒绝。
 */
async function dropHostSessionTraces(options: HostTraceOptions): Promise<number> {
  const trashDir = join(options.hostRoot, TRASH_DIR)
  // 上次运行的 residue 可能留在回收区里（rename 成功、rm 失败），重跑 purge 时
  // 目标已移出 sessions/、dropSessionLogs 扫描不到，这些完整副本会永久残留。
  // 所以每次入口先清扫回收区，把上次没删干净的东西删掉。
  await sweepTrash(trashDir, options.warn, options.failures)
  return dropSessionLogs({
    sessionStoreRoot: join(options.hostRoot, 'sessions'),
    // 回收区放在 sessions/ 之外：宿主扫 header 时不会把 .purge-trash 当会话目录。
    trashDir,
    agentId: options.agentId,
    sessionId: options.sessionId,
    warn: options.warn,
    failures: options.failures,
  })
}

/**
 * 清空回收区目录。上次 `discardIn` 的 residue（rename 成功、rm 失败）会留下
 * 完整会话日志副本，重跑 purge 时它已不在 sessions/ 下、扫描不到，必须在这里
 * 主动清掉，否则「彻底销毁」会永久留一份可恢复的副本。
 */
async function sweepTrash(trashDir: string, warn: (message: string) => void, failures: string[]): Promise<void> {
  let entries
  try {
    entries = await readdir(trashDir, { withFileTypes: true })
  } catch (cause) {
    // 回收区不存在是正常情况（从未产生 residue）。
    if (codeOf(cause) !== 'ENOENT') {
      warn(`清扫回收区失败：${messageOf(cause)}`)
      failures.push(`清扫回收区失败：${messageOf(cause)}`)
    }
    return
  }
  for (const entry of entries) {
    try {
      await rm(join(trashDir, entry.name), { recursive: true, force: true, maxRetries: 3 })
    } catch (cause) {
      // 残留删不掉 = 完整会话日志副本还躺在回收区里，「彻底销毁」不能报成功。
      // 与 dropSessionLogs 的 residue 同等待遇：进 failures，让 purge 抛 partial。
      warn(`清扫回收区残留失败：${entry.name}：${messageOf(cause)}`)
      failures.push(`回收区残留未清：${entry.name}：${messageOf(cause)}`)
    }
  }
}

/**
 * 把 target 挪进同一卷的回收区再删；挪不动就原地删。
 * 返回 `residue=true` 表示"文件已移出原位，但回收区里的副本没删干净"——
 * 这是删除不彻底，调用方必须记进 failures，否则「彻底销毁」会静默留完整副本。
 */
async function discardIn(trashDir: string, target: string): Promise<{ residue: boolean }> {
  try {
    await mkdir(trashDir, { recursive: true })
    const parked = join(trashDir, `${basename(target)}-${randomUUID()}`)
    await rename(target, parked)
    try {
      await rm(parked, { recursive: true, force: true, maxRetries: 3 })
      return { residue: false }
    } catch {
      // rename 成功 = 会话日志已从 sessions/ 移走；但回收区副本删不掉等于别处留了
      // 一份完整日志，必须上报，不能 `.catch(() => undefined)` 静默吞。
      return { residue: true }
    }
  } catch {
    // rename 失败（多半被占用）：退化成原地删。
  }
  await rm(target, { recursive: true, force: true, maxRetries: 3 })
  return { residue: false }
}

function countRows(db: SqlDriver, sql: string, params: readonly unknown[]): number {
  try {
    return db.all<Record<string, unknown>>(sql, params).length
  } catch {
    return 0
  }
}

/** 与快照引擎落文件名一致：`persona/<sanitizeName(id)>.json`。删除必须用同一套消毒。 */
function sanitizeName(value: string): string {
  return value.replace(/[^0-9A-Za-z._-]/g, '_').slice(0, 120) || 'anonymous'
}

/** 生成 `?, ?, ...` 占位符串（长度 = 数组长度）。 */
function placeholders(values: readonly unknown[]): string {
  return Array.from({ length: values.length }, () => '?').join(', ')
}

type AtomicOutcome = 'renamed' | 'inplace' | 'failed'

/**
 * 安全改写：临时文件 → fsync → rename。
 *
 * 关键保证：**原文件在成功之前一直完好**。rename 在 Windows 上会撞
 * EBUSY/EPERM（文件被 git / 杀软 / 编辑器短暂占用），所以退避重试；
 * 实在不行才原地覆盖，并且写完回读校验长度。
 */
async function atomicReplace(file: string, content: string, warn: (message: string) => void): Promise<AtomicOutcome> {
  const tmp = `${file}.${process.pid}.${Math.random().toString(36).slice(2, 8)}.tmp`
  try {
    await withRetry(async () => {
      const handle = await open(tmp, 'w')
      try {
        await handle.writeFile(content, 'utf8')
        await handle.sync()
      } finally {
        await handle.close()
      }
    })
  } catch (cause) {
    await safeUnlink(tmp)
    warn(`写临时文件失败，保留原文件：${file}：${messageOf(cause)}`)
    return 'failed'
  }

  try {
    await withRetry(() => rename(tmp, file))
    return 'renamed'
  } catch (cause) {
    warn(`rename 失败（${codeOf(cause) || 'unknown'}），退回原地覆盖：${file}`)
  }

  try {
    // 最后一招：原地截断重写。不是原子的，但比"删了写不进去"好。
    // 截断一旦开始，写失败会把原文件留在半截状态，所以先备份原文，失败好滚回去。
    let backup = ''
    try {
      backup = await readFile(file, 'utf8')
    } catch {
      backup = ''
    }
    await withRetry(async () => {
      const handle = await open(file, 'w')
      try {
        await handle.writeFile(content, 'utf8')
        await handle.sync()
      } finally {
        await handle.close()
      }
    })
    const verify = await readFile(file, 'utf8')
    if (verify !== content) {
      // 逐字节比对，不是只看长度：等长损坏也必须拦下。
      warn(`原地覆盖后内容不符，尝试回滚：${file}`)
      if (backup !== '') {
        try {
          await writeFile(file, backup, 'utf8')
        } catch (rollbackCause) {
          warn(`回滚失败：${file}：${messageOf(rollbackCause)}`)
        }
      }
      return 'failed'
    }
    await safeUnlink(tmp)
    return 'inplace'
  } catch (cause) {
    await safeUnlink(tmp)
    warn(`原地覆盖失败：${file}：${messageOf(cause)}`)
    return 'failed'
  }
}

/** 逐文件剔除属于该 Agent 的记录，最后追加墓碑（墓碑也写进当天文件）。 */
async function purgeJournal(options: PurgeJournalOptions): Promise<{ files: number; records: number; tombstone: boolean }> {
  const { root, workspaceId, agentId, warn, failures } = options
  const entityIds = new Set(options.entityIds)
  const devicesDir = join(root, 'journal', 'devices')
  let devices: string[]
  try {
    devices = await readdir(devicesDir)
  } catch {
    // 目录不存在 = 从未写过日志，属于正常状态（全新机器）。
    return { files: 0, records: 0, tombstone: await appendTombstone({ root, workspaceId, agentId, at: options.at }) }
  }

  const files: string[] = []
  for (const device of devices) {
    const dir = join(devicesDir, device)
    try {
      const names = (await readdir(dir)).filter((name) => name.endsWith('.jsonl'))
      for (const name of names) files.push(join(dir, name))
    } catch {
      continue
    }
  }

  // 归属判定必须带工作区：personaId / agentId 都不是全局唯一，而是按 workspace 隔离的
  // （persona.bind 用 personaId，entity.upsert 用 agentId）。只按 `personaId === agentId`
  // 会把另一个 workspace 里同名人格的绑定记录也误删。
  //
  // 三条分支对 workspaceId 的处理不同：
  // - entity 分支：entityId 是 ULID 全局唯一，且 entityIds 集合在删库前由
  //   `SELECT ... WHERE workspace_id AND agent_id` 播种，天然带 workspace 归属，
  //   不需要再查 workspaceId（version.open/close 只带 entityId、不带 workspaceId）。
  // - agent / persona 分支：必须显式 `workspaceId === workspaceId` 匹配。对
  //   `workspaceId === undefined` 默认放行是危险的——一条只带 agentId 没带
  //   workspaceId 的记录无法证明属于本工作区，物理销毁时会无差别剔除。
  const matches = (record: JournalRecordShape): boolean => {
    const explicitWs = record.workspaceId === workspaceId
    const mineByAgent = record.agentId === agentId && explicitWs
    const mineByEntity = typeof record.entityId === 'string' && entityIds.has(record.entityId)
    // persona.bind 记录带的是 personaId：不按它过滤，销毁后绑定还在，会话照样"继承"这个人。
    const mineByPersona = record.personaId === agentId && explicitWs
    return mineByAgent || mineByEntity || mineByPersona
  }

  // 第一遍：传递闭包收集本 agent 名下的 entityId。
  // version.open / version.close 只带 entityId、不带 agentId，只能靠"entityId 已属于
  // 本 agent"来归属；而 entityId 的来源有两处：删库前抓到的 options.entityIds，以及
  // journal 里带 agentId 的 entity.upsert 等记录。两处都可能不完整（库已删空、且上一轮
  // 已把 entity.upsert 清掉时只剩 version.*），所以反复迭代直到集合不再增长，避免
  // "entityId 出现在后面才处理的文件里"导致的漏收。
  let grew = true
  while (grew) {
    grew = false
    for (const file of files) {
      let raw: string
      try {
        raw = await readFile(file, 'utf8')
      } catch {
        continue
      }
      for (const line of raw.split('\n')) {
        if (line.trim() === '') continue
        let record: JournalRecordShape
        try {
          record = JSON.parse(line) as JournalRecordShape
        } catch {
          continue
        }
        const eid = typeof record.entityId === 'string' ? record.entityId : undefined
        if (eid === undefined) continue
        // 归属条件：记录本身属于本 agent（entity.upsert 等带 agentId 且 workspaceId 显式匹配），
        // 或记录的 entityId 已经在本 agent 名下（version.* 引用它）。
        // agentId 可能跨 workspace 重复（如 persona id），必须显式 workspaceId 匹配。
        const mine = (record.agentId === agentId && record.workspaceId === workspaceId) || entityIds.has(eid)
        if (mine && !entityIds.has(eid)) {
          entityIds.add(eid)
          grew = true
        }
      }
    }
  }

  // 在改写文件前扫描全 journal 最大 lc：改写会删掉本 agent 的记录，改写后再扫
  // 会漏掉它们的 lc，导致墓碑 lc 偏低（单设备时退化成 1，跨设备 replay 时其他
  // 设备的 upsert 仍可能排在墓碑后把 agent 复活）。
  const maxLc = await scanJournalMaxLc(devicesDir)

  let rewritten = 0
  let records = 0
  for (const file of files) {
    let raw: string
    try {
      raw = await readFile(file, 'utf8')
    } catch (cause) {
      failures.push(`读 journal 失败：${file}：${messageOf(cause)}`)
      warn(`读 journal 失败，跳过 ${file}：${messageOf(cause)}`)
      continue
    }
    const lines = raw.split('\n').filter((line) => line.trim() !== '')
    const kept: string[] = []
    let removed = 0
    for (const line of lines) {
      let record: JournalRecordShape
      try {
        record = JSON.parse(line) as JournalRecordShape
      } catch {
        kept.push(line)
        continue
      }
      if (matches(record)) {
        removed++
        continue
      }
      kept.push(line)
    }
    if (removed === 0) continue

    const outcome = await atomicReplace(file, kept.map((line) => `${line}\n`).join(''), warn)
    if (outcome === 'failed') {
      // 文件没改写成功 = 正文还在。这必须算失败，否则前端会显示"已销毁"。
      failures.push(`journal 未改写：${file}（残留 ${removed} 条）`)
      continue
    }
    rewritten++
    records += removed
  }

  const tombstone = await appendTombstone({ root, workspaceId, agentId, at: options.at, baseLc: maxLc })
  return { files: rewritten + (tombstone ? 1 : 0), records, tombstone }
}

/** 扫描所有设备的 journal，取最大 Lamport 逻辑时钟（无记录返回 0）。 */
async function scanJournalMaxLc(devicesDir: string): Promise<number> {
  let maxLc = 0
  let devices: string[]
  try {
    devices = await readdir(devicesDir)
  } catch {
    return 0
  }
  for (const device of devices) {
    const dir = join(devicesDir, device)
    let names: string[]
    try {
      names = (await readdir(dir)).filter((name) => name.endsWith('.jsonl'))
    } catch {
      continue
    }
    for (const name of names) {
      let raw: string
      try {
        raw = await readFile(join(dir, name), 'utf8')
      } catch {
        continue
      }
      for (const line of raw.split('\n')) {
        if (line.trim() === '') continue
        try {
          const record = JSON.parse(line) as JournalRecordShape
          if (typeof record.lc === 'number' && record.lc > maxLc) maxLc = record.lc
        } catch {
          continue
        }
      }
    }
  }
  return maxLc
}

/** 扫描 purge 设备的墓碑最大 seq（无记录返回 0）。 */
async function scanPurgeMaxSeq(purgeDir: string): Promise<number> {
  let maxSeq = 0
  let names: string[]
  try {
    names = (await readdir(purgeDir)).filter((name) => name.endsWith('.jsonl'))
  } catch {
    return 0
  }
  for (const name of names) {
    let raw: string
    try {
      raw = await readFile(join(purgeDir, name), 'utf8')
    } catch {
      continue
    }
    for (const line of raw.split('\n')) {
      if (line.trim() === '') continue
      try {
        const record = JSON.parse(line) as JournalRecordShape
        if (typeof record.seq === 'number' && record.seq > maxSeq) maxSeq = record.seq
      } catch {
        continue
      }
    }
  }
  return maxSeq
}

/** 追加墓碑。失败返回 false（不抛），由调用方决定是否重试。 */
async function appendTombstone(options: {
  root: string
  workspaceId: string
  agentId: string
  at: number
  /** 已知的 journal 最大 lc（由调用方在改写文件前扫描），墓碑取它 +1。 */
  baseLc?: number
}): Promise<boolean> {
  const { root, workspaceId, agentId, at } = options
  const devicesDir = join(root, 'journal', 'devices')
  const today = new Date(at).toISOString().slice(0, 10)
  const dir = join(devicesDir, 'purge')
  const file = join(dir, `${today}.jsonl`)
  // Lamport 逻辑时钟：墓碑必须排在所有现有记录之后，否则跨设备 replay 时
  // 其他设备的 upsert（lc 更大）会排在墓碑（lc=0）后面，把已销毁的 Agent 复活。
  // 这里取全 journal 最大 lc + 1，让墓碑在因果序里压过所有已落盘的记录。
  // baseLc 由 purgeJournal 在改写前扫描传入——改写会删掉本 agent 的记录，
  // 若改写后再扫会漏掉它们的 lc，单设备时墓碑退化成 lc=1。
  const lc = (options.baseLc ?? (await scanJournalMaxLc(devicesDir))) + 1
  // seq 递增：墓碑虽绕过 Journal 落盘，但 purge 设备内仍需唯一递增的 seq。
  // 否则 readMerged({sinceSeq:{purge:n}}) 会一次跳过所有墓碑（它们都 seq=1），
  // 被销毁的 agent 在增量回放时复活（P2-I）。第一个墓碑 seq=1（readDevice 的
  // seq > 0 过滤要求 seq 必须 >=1），后续每次 +1。
  const seq = (await scanPurgeMaxSeq(dir)) + 1
  const tombstone = JSON.stringify({
    v: 1,
    lc,
    seq,
    op: 'agent.purge',
    workspaceId,
    agentId,
    at,
    device: 'purge',
  })

  try {
    await mkdir(dir, { recursive: true })
    let existing = ''
    try {
      existing = await readFile(file, 'utf8')
    } catch {
      existing = ''
    }
    const sep = existing === '' || existing.endsWith('\n') ? '' : '\n'
    // 墓碑用追加语义，但同样走"临时文件 + rename"，避免追加一半断电留下坏行。
    await atomicReplace(file, `${existing}${sep}${tombstone}\n`, () => undefined)
    const verify = await readFile(file, 'utf8')
    return verify.includes(tombstone)
  } catch {
    return false
  }
}

/**
 * 派生状态：persona/<agent>.json 与 state/*.json 里的引用。
 *
 * 这些文件由快照模块打包进 git；库里删干净、它们还在的话，
 * 恢复后的下一次 distill 会顺着绑定关系把"人格"重新认回来。
 */
async function scrubDerivedState(options: {
  root: string
  workspaceId: string
  agentId: string
  sessionId?: string
  warn: (message: string) => void
  failures: string[]
}): Promise<void> {
  const { root, workspaceId, agentId, sessionId, warn, failures } = options

  // persona 文件 key 与 persona_state 行一样可能混用「人格 id」与「会话 id」两套
  // 空间（继承路径、历史数据、手动改绑），两个都要按快照引擎的 sanitizeName 消毒后
  // 删除；漏掉一个，「销毁了但 persona/<id>.json 还在」会被下一次快照漫游到别的
  // 机器复活（P0-C）。
  const idKeys = [...new Set([agentId, sessionId].filter((v): v is string => typeof v === 'string' && v !== ''))]
  for (const key of idKeys) {
    // 文件路径由 id 拼成，必须先过 scope 令牌校验——`../` 之类的穿越字符会把
    // `persona/<id>.json` 变成删到 persona/ 之外的文件。
    if (!isSafeScopeToken(key)) {
      failures.push(`id 含非法字符，跳过人格文件删除：${key}`)
      warn(`id 含非法字符，跳过人格文件删除：${key}`)
      continue
    }
    const personaFile = join(root, 'persona', `${sanitizeName(key)}.json`)
    try {
      await rm(personaFile, { force: true })
    } catch (cause) {
      failures.push(`删人格文件失败：${messageOf(cause)}`)
      warn(`删人格文件失败 ${personaFile}：${messageOf(cause)}`)
    }
  }

  const identityFile = join(root, 'state', 'persona-identity.json')
  await scrubJson(identityFile, (doc) => {
    const identities = Array.isArray(doc.identities) ? (doc.identities as Record<string, unknown>[]) : []
    const kept = identities.filter(
      (row) => !idKeys.includes(row.agentId as string) && !idKeys.includes(row.personaId as string) && row.workspaceId === workspaceId,
    )
    return { ...doc, identities: [...kept, ...identities.filter((row) => row.workspaceId !== workspaceId)] }
  }, warn, failures)

  const agentsFile = join(root, 'state', 'agents.json')
  await scrubJson(agentsFile, (doc) => {
    const agents = Array.isArray(doc.agents) ? (doc.agents as Record<string, unknown>[]) : []
    return { ...doc, agents: agents.filter((row) => !idKeys.includes(row.agentId as string)) }
  }, warn, failures)
}

/** 读 JSON → 交给 transform → 原子写回。任何一步失败都只记录，不上抛。 */
async function scrubJson(
  file: string,
  transform: (doc: Record<string, unknown>) => Record<string, unknown>,
  warn: (message: string) => void,
  failures: string[],
): Promise<void> {
  let raw: string
  try {
    raw = await readFile(file, 'utf8')
  } catch {
    // 文件不存在 = 没什么可清，正常。
    return
  }
  let doc: Record<string, unknown>
  try {
    const parsed: unknown = JSON.parse(raw)
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return
    doc = parsed as Record<string, unknown>
  } catch (cause) {
    failures.push(`解析失败：${file}：${messageOf(cause)}`)
    warn(`状态文件损坏，跳过 ${file}：${messageOf(cause)}`)
    return
  }
  try {
    const next = transform(doc)
    const outcome = await atomicReplace(file, `${JSON.stringify(next, null, 2)}\n`, warn)
    if (outcome === 'failed') failures.push(`状态文件未改写：${file}`)
  } catch (cause) {
    failures.push(`写状态文件失败：${file}：${messageOf(cause)}`)
    warn(`写状态文件失败 ${file}：${messageOf(cause)}`)
  }
}
