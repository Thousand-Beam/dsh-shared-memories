/**
 * 会话身份 → 人格身份 的注册表（修"换会话就失忆"）。
 *
 * 事故链：宿主里 `agent.id === agent.session.id`，新建会话 = 新 agent id；
 * persona_state / memory_entity / agent_skill / quarantine 全都按 agent_id 存，
 * 于是新会话读不到任何旧数据，看起来就是"人格丢了、记忆 0 条"。
 *
 * 这一层只做一件事：把一次性会话 id 解析成稳定人格 id。
 * 所有读写路径统一走 `resolve()`（或构造 scope 时解析一次），下游一行不用改。
 *
 * 继承策略（可解释、可回退）：
 * 1. 会话已绑定 → 直接返回它的人格；
 * 2. 该工作区还没有任何人 → 自己成为人格（persona_id = agentId）；
 * 3. 该工作区已有人格 → 继承**最近活跃**的那一个（新会话默认延续上一个人格）。
 *
 * 想并行两个真正独立的人格：`bindTo(agentId, personaId)` 显式改绑，
 * 或在配置里把 `identity.inheritOnNewSession` 关掉（见 config）。
 */
import type { SqlDriver } from '../../shared/types.js'
import type { Journal } from '../../shared/journal.js'
import type { PersonaBindSource, PersonaIdentity, PersonaSummary } from '../../shared/persona-identity.js'
import { looksLikeSessionId } from '../../shared/persona-identity.js'

export interface PersonaIdentityStoreOptions {
  readonly db: SqlDriver
  readonly journal?: Journal
  readonly clock?: () => number
  readonly onWarn?: (message: string) => void
  /** 新会话是否继承本工作区最近活跃的人格。关掉 = 每个会话都是独立人格（旧行为）。 */
  readonly inheritOnNewSession?: boolean
  /** 认领时间窗：超过这么久没活动的人格不再被新会话继承（默认 7 天）。 */
  readonly inheritWindowMs?: number
}

interface IdentityRow {
  agent_id: string
  workspace_id: string
  persona_id: string
  bound_at: number
  last_seen_at: number
}

export class PersonaIdentityStore {
  readonly #db: SqlDriver
  readonly #journal: Journal | undefined
  readonly #clock: () => number
  readonly #onWarn: (message: string) => void
  readonly #inherit: boolean
  readonly #windowMs: number

  constructor(options: PersonaIdentityStoreOptions) {
    this.#db = options.db
    this.#journal = options.journal
    this.#clock = options.clock ?? (() => Date.now())
    this.#onWarn = options.onWarn ?? (() => {})
    this.#inherit = options.inheritOnNewSession ?? true
    this.#windowMs = options.inheritWindowMs ?? 7 * 24 * 3_600_000
  }

  /**
   * 把会话 id 解析成人格 id。
   *
   * 查不到映射时**返回原值**——老库、测试、以及"用户从没进过控制台"的场景，
   * 行为必须与升级前逐字一致，不能因为多了这层指针就改变别人的隔离语义。
   */
  resolve(agentId: string): string {
    if (!agentId) return agentId
    const row = this.#db.one<{ persona_id: string }>(
      `SELECT persona_id FROM persona_identity WHERE agent_id = ?`,
      [agentId],
    )
    return row?.persona_id ?? agentId
  }

  /** 会话是否已经绑定过（界面上用来区分"新会话待继承"与"已挂到某人名下"）。 */
  lookup(agentId: string): PersonaIdentity | undefined {
    const row = this.#db.one<IdentityRow>(
      `SELECT agent_id, workspace_id, persona_id, bound_at, last_seen_at
         FROM persona_identity WHERE agent_id = ?`,
      [agentId],
    )
    return row ? toIdentity(row) : undefined
  }

  /** 某人格下挂着的全部会话（含它的第一个会话）。 */
  sessionsOf(personaId: string): string[] {
    return this.#db
      .all<{ agent_id: string }>(
        `SELECT agent_id FROM persona_identity WHERE persona_id = ? ORDER BY bound_at`,
        [personaId],
      )
      .map((row) => row.agent_id)
  }

  /** 工作区内的人格清单（每个带会话数）。 */
  personas(workspaceId: string): PersonaSummary[] {
    return this.#db
      .all<{ persona_id: string; sessions: number; last_seen_at: number }>(
        `SELECT persona_id, COUNT(*) AS sessions, MAX(last_seen_at) AS last_seen_at
           FROM persona_identity WHERE workspace_id = ?
          GROUP BY persona_id ORDER BY last_seen_at DESC, persona_id`,
        [workspaceId],
      )
      .map((row) => ({
        personaId: row.persona_id,
        workspaceId,
        sessionCount: Number(row.sessions),
        lastSeenAt: Number(row.last_seen_at),
      }))
  }

  /** 整表（快照用）：绑定关系必须跟着走，否则换台机器又是"新会话新人格"。 */
  all(): PersonaIdentity[] {
    return this.#db
      .all<IdentityRow>(
        `SELECT agent_id, workspace_id, persona_id, bound_at, last_seen_at
           FROM persona_identity ORDER BY workspace_id, bound_at`,
        [],
      )
      .map(toIdentity)
  }

  /**
   * 登记一次会话出现，并返回它应该使用的人格 id。
   *
   * 幂等：同一个会话反复出现只更新 `last_seen_at`，不会新增行、也不会改绑。
   */
  async touch(agentId: string, workspaceId: string, by: PersonaBindSource = 'auto'): Promise<string> {
    if (!agentId) return agentId
    const at = this.#clock()
    const existing = this.lookup(agentId)
    if (existing) {
      this.#db.run(`UPDATE persona_identity SET last_seen_at = ? WHERE agent_id = ?`, [at, agentId])
      return existing.personaId
    }
    const personaId = this.#pickPersona(workspaceId) ?? agentId
    this.#db.run(
      `INSERT INTO persona_identity (agent_id, workspace_id, persona_id, bound_at, last_seen_at)
       VALUES (?,?,?,?,?)
       ON CONFLICT(agent_id) DO UPDATE SET last_seen_at = excluded.last_seen_at`,
      [agentId, workspaceId, personaId, at, at],
    )
    await this.#append({ agentId, workspaceId, personaId, at, by })
    return personaId
  }

  /** 手动改绑：把某个会话挂到指定人格下（界面上"这不是新人格，接上一个 Agent"）。 */
  async bindTo(agentId: string, workspaceId: string, personaId: string, by: PersonaBindSource = 'user'): Promise<string> {
    if (!agentId || !personaId) return agentId
    const at = this.#clock()
    this.#db.run(
      `INSERT INTO persona_identity (agent_id, workspace_id, persona_id, bound_at, last_seen_at)
       VALUES (?,?,?,?,?)
       ON CONFLICT(agent_id) DO UPDATE SET
         workspace_id = excluded.workspace_id,
         persona_id = excluded.persona_id,
         last_seen_at = excluded.last_seen_at`,
      [agentId, workspaceId, personaId, at, at],
    )
    await this.#append({ agentId, workspaceId, personaId, at, by })
    return personaId
  }

  /** 恢复时用：直接落库，**不写 journal**（重放自己不能再产生新事件）。 */
  replace(identity: PersonaIdentity): void {
    this.#db.run(
      `INSERT INTO persona_identity (agent_id, workspace_id, persona_id, bound_at, last_seen_at)
       VALUES (?,?,?,?,?)
       ON CONFLICT(agent_id) DO UPDATE SET
         workspace_id = excluded.workspace_id,
         persona_id = excluded.persona_id,
         last_seen_at = MAX(persona_identity.last_seen_at, excluded.last_seen_at)`,
      [identity.agentId, identity.workspaceId, identity.personaId, identity.boundAt, identity.lastSeenAt],
    )
  }

  /** 最近活跃的人格；关掉继承时永远返回 undefined（= 每个会话独立）。 */
  #pickPersona(workspaceId: string): string | undefined {
    if (!this.#inherit) return undefined
    const since = this.#clock() - this.#windowMs
    const row = this.#db.one<{ persona_id: string }>(
      `SELECT persona_id FROM persona_identity
        WHERE workspace_id = ? AND last_seen_at >= ?
        ORDER BY last_seen_at DESC, bound_at ASC LIMIT 1`,
      [workspaceId, since],
    )
    return row?.persona_id
  }

  async #append(input: {
    agentId: string
    workspaceId: string
    personaId: string
    at: number
    by: PersonaBindSource
  }): Promise<void> {
    try {
      await this.#journal?.append({
        op: 'persona.bind',
        at: input.at,
        agentId: input.agentId,
        workspaceId: input.workspaceId,
        personaId: input.personaId,
        by: input.by,
      })
    } catch (cause) {
      // 不回滚：内存里已经能用，只是这次绑定不会漫游。但要让人看见。
      this.#onWarn(`persona.bind journal 写入失败：${cause instanceof Error ? cause.message : String(cause)}`)
    }
  }
}

/**
 * 老库一次性回填：把"人"和"会话"对上号。
 *
 * 升级到 v5 之前，每个会话都会在 persona_state 里留一行（`ensureAgentRow` 干的），
 * 于是控制台下拉框里常年挂着一堆 uuid 名字的空壳。回填规则：
 *
 * 1. 每个工作区选一个**锚点人格**：记忆最多的那个；并列时优先"有真名字"的，
 *    再并列取最早登记的（先来的通常是用户真正在用的那个）。
 * 2. 锚点自己绑自己（幂等）。
 * 3. 其它行：**既没名字、又没有记忆**的，视为历史遗留的空壳会话，绑到锚点上；
 *    有名字或有记忆的，保持独立（那是用户真的要并行的另一个 Agent）。
 *
 * 不搬任何业务数据，只补指针——判错了删一行就能修正。
 */
export function backfillPersonaIdentities(db: SqlDriver, clock: () => number = () => Date.now()): number {
  const rows = db.all<{
    agent_id: string
    workspace_id: string
    name: string
    updated_at: number
    memory_count: number
    bound: number
  }>(
    `SELECT p.agent_id,
            p.workspace_id,
            p.name,
            p.updated_at,
            (SELECT COUNT(*) FROM memory_entity e
              WHERE e.workspace_id = p.workspace_id AND e.agent_id = p.agent_id) AS memory_count,
            (SELECT COUNT(*) FROM persona_identity i WHERE i.agent_id = p.agent_id) AS bound
       FROM persona_state p`,
    [],
  )

  const byWorkspace = new Map<string, typeof rows>()
  for (const row of rows) {
    const bucket = byWorkspace.get(row.workspace_id) ?? []
    bucket.push(row)
    byWorkspace.set(row.workspace_id, bucket)
  }

  const at = clock()
  let adopted = 0
  for (const [workspaceId, bucket] of byWorkspace) {
    const anchor = pickAnchor(bucket)
    if (!anchor) continue
    db.run(
      `INSERT INTO persona_identity (agent_id, workspace_id, persona_id, bound_at, last_seen_at)
       VALUES (?,?,?,?,?)
       ON CONFLICT(agent_id) DO NOTHING`,
      [anchor.agent_id, workspaceId, anchor.agent_id, at, at],
    )
    for (const row of bucket) {
      if (row.agent_id === anchor.agent_id) continue
      if (Number(row.bound) > 0) continue
      const nameless = row.name.trim() === '' || looksLikeSessionId(row.name)
      const empty = Number(row.memory_count) === 0
      // 有名字或有记忆的行是"另一个真在用的 Agent"，保持独立，但也要显式绑自己：
      // 否则 persona_identity 里没有它，控制台的"人格数"会少算一个。
      const target = nameless && empty ? anchor.agent_id : row.agent_id
      if (target === row.agent_id) {
        db.run(
          `INSERT INTO persona_identity (agent_id, workspace_id, persona_id, bound_at, last_seen_at)
           VALUES (?,?,?,?,?)
           ON CONFLICT(agent_id) DO NOTHING`,
          [row.agent_id, workspaceId, row.agent_id, at, at],
        )
        continue
      }
      db.run(
        `INSERT INTO persona_identity (agent_id, workspace_id, persona_id, bound_at, last_seen_at)
         VALUES (?,?,?,?,?)
         ON CONFLICT(agent_id) DO NOTHING`,
        [row.agent_id, workspaceId, anchor.agent_id, at, at],
      )
      adopted++
    }
  }
  return adopted
}

function pickAnchor<T extends { agent_id: string; name: string; updated_at: number; memory_count: number }>(
  bucket: readonly T[],
): T | undefined {
  let best: T | undefined
  for (const row of bucket) {
    if (!best) {
      best = row
      continue
    }
    const a = Number(row.memory_count)
    const b = Number(best.memory_count)
    if (a !== b) {
      if (a > b) best = row
      continue
    }
    const namedA = row.name.trim() !== '' && !looksLikeSessionId(row.name)
    const namedB = best.name.trim() !== '' && !looksLikeSessionId(best.name)
    if (namedA !== namedB) {
      if (namedA) best = row
      continue
    }
    if (Number(row.updated_at) < Number(best.updated_at)) best = row
  }
  return best
}

/** 只读解析：给不想构造 store 的调用点（渲染层、路由）用。 */export function resolvePersonaId(db: SqlDriver, agentId: string): string {
  if (!agentId) return agentId
  try {
    const row = db.one<{ persona_id: string }>(
      `SELECT persona_id FROM persona_identity WHERE agent_id = ?`,
      [agentId],
    )
    return row?.persona_id ?? agentId
  } catch {
    // 表还没建（活库半迁移）：退回原值，宁可不继承也不要抛断请求。
    return agentId
  }
}

function toIdentity(row: IdentityRow): PersonaIdentity {
  return {
    agentId: row.agent_id,
    workspaceId: row.workspace_id,
    personaId: row.persona_id,
    boundAt: Number(row.bound_at),
    lastSeenAt: Number(row.last_seen_at),
  }
}
