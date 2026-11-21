/**
 * 会话策略存储：无痕开关 + 归档提取模式。
 *
 * 设计上的两个硬约束：
 *
 * ① **默认不落行**。没有策略行 = `{ephemeral:false, archiveMode:'incremental'}`，
 *    与升级前行为一致。只有用户显式改过才写行——这样"忘了清理"不会变成事故。
 *
 * ② **无痕判定必须便宜**。它要卡在每一条记忆写入前面（包括深度提炼的每一块），
 *    所以是一条按主键的单行查询，不 join、不解析人格。
 */

import type { SqlDriver } from '../../shared/types.js'
import {
  DEFAULT_ARCHIVE_MODE,
  isArchiveMode,
  normalizePolicyInput,
  type ArchiveMode,
  type SessionPolicy,
  type SessionPolicyInput,
} from '../../shared/session-policy.js'

interface PolicyRow {
  session_id: string
  workspace_id: string
  agent_id: string
  ephemeral: number
  archive_mode: string
  updated_at: number
}

export interface SessionPolicyStoreOptions {
  readonly db: SqlDriver
  readonly clock?: () => number
  readonly onWarn?: (message: string) => void
}

export class SessionPolicyStore {
  readonly #db: SqlDriver
  readonly #clock: () => number
  readonly #warn: (message: string) => void

  constructor(options: SessionPolicyStoreOptions) {
    this.#db = options.db
    this.#clock = options.clock ?? (() => Date.now())
    this.#warn = options.onWarn ?? (() => undefined)
  }

  /** 读策略；没有行时返回默认值（不写库）。 */
  get(sessionId: string, workspaceId: string, agentId = ''): SessionPolicy {
    const row = this.#row(sessionId)
    if (!row) {
      return {
        sessionId,
        workspaceId,
        agentId,
        ephemeral: false,
        archiveMode: DEFAULT_ARCHIVE_MODE,
        updatedAt: 0,
      }
    }
    return {
      sessionId: row.session_id,
      workspaceId: row.workspace_id,
      agentId: row.agent_id,
      ephemeral: Number(row.ephemeral) === 1,
      archiveMode: isArchiveMode(row.archive_mode) ? row.archive_mode : DEFAULT_ARCHIVE_MODE,
      updatedAt: Number(row.updated_at),
    }
  }

  /** 无痕判定（写入闸门用）：只查一列，容忍库异常时按"非无痕"放行并告警。 */
  isEphemeral(sessionId: string): boolean {
    if (sessionId === '') return false
    try {
      const row = this.#db.one<{ ephemeral?: number }>(
        'SELECT ephemeral FROM session_policy WHERE session_id = ?',
        [sessionId],
      )
      return Number(row?.ephemeral ?? 0) === 1
    } catch (cause) {
      this.#warn(`无痕判定失败，按普通会话处理：${cause instanceof Error ? cause.message : String(cause)}`)
      return false
    }
  }

  /** 该工作区下所有显式设置过策略的会话。 */
  all(workspaceId: string): SessionPolicy[] {
    const rows = this.#db.all<PolicyRow>(
      'SELECT * FROM session_policy WHERE workspace_id = ? ORDER BY updated_at DESC',
      [workspaceId],
    )
    return rows.map((row) => ({
      sessionId: row.session_id,
      workspaceId: row.workspace_id,
      agentId: row.agent_id,
      ephemeral: Number(row.ephemeral) === 1,
      archiveMode: isArchiveMode(row.archive_mode) ? row.archive_mode : DEFAULT_ARCHIVE_MODE,
      updatedAt: Number(row.updated_at),
    }))
  }

  /** 写策略（部分更新，未提供的字段保持原值）。 */
  set(sessionId: string, workspaceId: string, input: SessionPolicyInput, agentId = ''): SessionPolicy {
    const current = this.get(sessionId, workspaceId, agentId)
    const patch = normalizePolicyInput(input)
    const next: SessionPolicy = {
      sessionId,
      workspaceId,
      agentId: agentId === '' ? current.agentId : agentId,
      ephemeral: patch.ephemeral ?? current.ephemeral,
      archiveMode: (patch.archiveMode ?? current.archiveMode) as ArchiveMode,
      updatedAt: this.#clock(),
    }
    this.#db.run(
      `INSERT INTO session_policy (session_id, workspace_id, agent_id, ephemeral, archive_mode, updated_at)
       VALUES (?,?,?,?,?,?)
       ON CONFLICT(session_id) DO UPDATE SET
         workspace_id = excluded.workspace_id,
         agent_id     = excluded.agent_id,
         ephemeral    = excluded.ephemeral,
         archive_mode = excluded.archive_mode,
         updated_at   = excluded.updated_at`,
      [
        next.sessionId,
        next.workspaceId,
        next.agentId,
        next.ephemeral ? 1 : 0,
        next.archiveMode,
        next.updatedAt,
      ],
    )
    return next
  }

  /** 关掉无痕（或清理策略行）：无痕会话结束时用。 */
  clear(sessionId: string): void {
    // 与 purge/restore 的清理对齐：策略行删掉后，提炼水位（distill_cursor）必须
    // 跟着走，否则留下孤儿行——会话重开时继承旧水位、销毁后残留隐私计数。
    this.#db.run('DELETE FROM distill_cursor WHERE session_id = ?', [sessionId])
    this.#db.run('DELETE FROM session_policy WHERE session_id = ?', [sessionId])
  }

  /** 该工作区当前处于无痕状态的会话（快照闸门与 UI 用）。 */
  ephemeralSessions(workspaceId: string): string[] {
    return this.#db
      .all<{ session_id: string }>(
        'SELECT session_id FROM session_policy WHERE workspace_id = ? AND ephemeral = 1 ORDER BY updated_at DESC',
        [workspaceId],
      )
      .map((row) => row.session_id)
  }

  /** 物理删除某个 Agent 下所有会话策略（彻底销毁时跟着走）。 */
  purgeAgent(workspaceId: string, agentId: string): number {
    const before = this.#db.all<{ session_id: string }>(
      'SELECT session_id FROM session_policy WHERE workspace_id = ? AND agent_id = ?',
      [workspaceId, agentId],
    )
    // 提炼水位一起清（与 clear 同因）：策略没了水位就是孤儿行。
    for (const row of before) {
      this.#db.run('DELETE FROM distill_cursor WHERE session_id = ?', [row.session_id])
    }
    this.#db.run('DELETE FROM session_policy WHERE workspace_id = ? AND agent_id = ?', [workspaceId, agentId])
    return before.length
  }

  #row(sessionId: string): PolicyRow | undefined {
    try {
      return this.#db.one<PolicyRow>('SELECT * FROM session_policy WHERE session_id = ?', [sessionId])
    } catch (cause) {
      this.#warn(`读取会话策略失败：${cause instanceof Error ? cause.message : String(cause)}`)
      return undefined
    }
  }
}

/**
 * 抹掉"这条会话存在过"的痕迹——**只在这条会话名下没有任何记忆时**动手。
 *
 * 为什么需要补这一刀：新建会话时宿主的顺序是
 *   `sessions.create()` → 触发 `agent/created` → 才把 sessionId 返回给客户端，
 * 而"无痕"这个选择是客户端拿到 id 之后才写进策略的。中间那一瞬，
 * `agent/created` 已经按普通会话给它登记了 persona_identity 与 persona_state。
 * 不删的话，"无痕"在库里照样留一行——和"从没聊过"一模一样地留着，
 * 下次冷启动归并甚至可能把它并进别人名下。
 *
 * 保守条件：名下已有 memory_entity 就一行都不碰。宁可留一行绑定，
 * 也不能把一段真实记忆的归属删掉。
 */
export function forgetSessionTraces(db: SqlDriver, workspaceId: string, sessionId: string): number {
  if (sessionId === '') return 0
  try {
    const owned = db.one<{ n: number }>(
      'SELECT COUNT(*) AS n FROM memory_entity WHERE workspace_id = ? AND agent_id = ?',
      [workspaceId, sessionId],
    )
    if (Number(owned?.n ?? 0) > 0) return 0
    let removed = 0
    db.transaction(() => {
      removed += db.run('DELETE FROM persona_identity WHERE agent_id = ?', [sessionId]).changes
      removed += db.run('DELETE FROM persona_state WHERE agent_id = ? AND workspace_id = ?', [
        sessionId,
        workspaceId,
      ]).changes
      removed += db.run('DELETE FROM agent_skill WHERE workspace_id = ? AND agent_id = ?', [
        workspaceId,
        sessionId,
      ]).changes
    })
    return removed
  } catch {
    // 老库缺表：没有那张表就没有那条痕迹可删，不该因此让策略写入失败。
    return 0
  }
}
/**
 * 泄漏巡检：无痕会话名下**不该有任何记忆痕迹**。
 *
 * 闸门要是漏了（新写入路径没走 DistillService、历史遗留的孤儿行），
 * 快照就会把"本该不存在的东西"推到远端 —— 那时候再怎么删都晚了。
 * 所以快照前先查一遍：有泄漏就拒绝快照并告警，让人先把闸门堵上。
 */
export function ephemeralLeaks(
  db: SqlDriver,
  workspaceId: string,
  sessions: readonly string[],
): string[] {
  if (sessions.length === 0) return []
  const marks = sessions.map(() => '?').join(',')
  const params = [workspaceId, ...sessions] as const
  const leaked = new Set<string>()
  const probe = (sql: string): void => {
    for (const row of db.all<{ agent_id: string }>(sql, params)) leaked.add(row.agent_id)
  }
  try {
    probe(`SELECT DISTINCT agent_id FROM memory_entity WHERE workspace_id = ? AND agent_id IN (${marks})`)
    probe(`SELECT DISTINCT agent_id FROM pitfall WHERE workspace_id = ? AND agent_id IN (${marks})`)
    probe(`SELECT DISTINCT agent_id FROM quarantine WHERE workspace_id = ? AND agent_id IN (${marks})`)
    probe(`SELECT DISTINCT agent_id FROM persona_identity WHERE workspace_id = ? AND agent_id IN (${marks})`)
  } catch {
    // 老库缺表：没有那些表就没有那条泄漏通道。
  }
  return [...leaked]
}
