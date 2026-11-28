/**
 * dsh-shared-memories — 技能注册表（SkillRegistry）
 * ---------------------------------------------------------------------------
 * 记忆按 (workspace, agent) 隔离，**能力也必须按 (workspace, agent) 隔离**。
 * 否则 A 挂了 `code-exec`、B 只挂 `web-search`，一次提示词拼装就把两张工具表
 * 混在一起了 —— 模型会尝试调用一个它根本没有的工具，而 SDK 报的是"工具不存在"，
 * 排查起来像灵异事件。
 *
 * 三条不变式（写这个类之前先定死，否则实现会跑偏）：
 *
 *   1. **每个查询都带 scope，没有"可选"分支**。和 ScopedQuery 一个套路：
 *      `WHERE workspace_id = ? AND agent_id = ?` 是唯一入口，不提供"查全部"的
 *      公开方法 —— 想跨 Agent 看，只能 `counts(workspaceId)` 拿数量。
 *   2. **写操作同时落两张账**：SQLite（本机可用）+ journal（可漫游）。
 *      只写 SQLite = 换机丢技能；只写 journal = 本机下次查询读不到。
 *   3. **技能本体不进库**。我们存 `skillId / version / enabled / config`，
 *      真正的工具实现由宿主按这张表挂回 —— 复制别人的代码进 git 是越界。
 */

import type { Journal } from '../../shared/journal.js'
import type { Scope } from '../../shared/scope.js'
import { assertScope } from '../../shared/scope.js'
import type {
  SkillBindInput,
  SkillBinding,
  SkillGrantSource,
} from '../../shared/skills.js'
import { normalizeBindings, normalizeSkillId, normalizeSkillVersion } from '../../shared/skills.js'
import type { SqlDriver } from '../../shared/types.js'

/** 作用域不对时抛这个：调用方（HTTP / 工具层）据此返回 403 而不是 500。 */
export class SkillScopeError extends Error {
  readonly code = 'skill-scope'
  constructor(message: string) {
    super(message)
    this.name = 'SkillScopeError'
  }
}

export interface SkillRegistryOptions {
  readonly db: SqlDriver
  /** 缺省时只落 SQLite（单机模式）。有 journal 才具备漫游能力。 */
  readonly journal?: Journal | undefined
  readonly clock?: () => number
  readonly onWarn?: (message: string) => void
}

interface SkillRow {
  skill_id: string
  version: string
  enabled: number
  config: string
  granted_by: string
  updated_at: number
}

export class SkillRegistry {
  readonly #db: SqlDriver
  readonly #journal: Journal | undefined
  readonly #clock: () => number
  readonly #onWarn: (message: string) => void

  constructor(options: SkillRegistryOptions) {
    this.#db = options.db
    this.#journal = options.journal
    this.#clock = options.clock ?? Date.now
    this.#onWarn = options.onWarn ?? (() => {})
  }

  /** 该 Agent 在当前工作区挂着的全部技能（含已停用的）。 */
  list(scope: Scope): SkillBinding[] {
    assertScope(scope, 'SkillRegistry.list')
    return readSkillBindings(this.#db, scope)
  }

  /** 挂载/更新一个技能。已存在则覆盖版本与参数（幂等）。 */
  async bind(scope: Scope, input: SkillBindInput, by?: SkillGrantSource): Promise<SkillBinding> {
    assertScope(scope, 'SkillRegistry.bind')
    const skillId = normalizeSkillId(input.skillId)
    if (!skillId) throw new SkillScopeError(`技能 id 不合法：${String(input.skillId)}`)
    const binding: SkillBinding = {
      skillId,
      version: normalizeSkillVersion(input.version),
      enabled: input.enabled !== false,
      config: input.config,
      grantedBy: by ?? input.grantedBy ?? 'user',
      updatedAt: this.#clock(),
    }
    this.#writeRow(scope, binding)
    await this.#append({
      op: 'skill.bind',
      at: binding.updatedAt ?? this.#clock(),
      workspaceId: scope.workspaceId,
      agentId: scope.agentId,
      skillId: binding.skillId,
      version: binding.version ?? '',
      enabled: binding.enabled,
      config: binding.config ?? {},
      grantedBy: binding.grantedBy ?? 'user',
    })
    return binding
  }

  /** 解绑。返回是否真的删掉了一行（没挂过就是 false，不报错）。 */
  async unbind(scope: Scope, skillId: string): Promise<boolean> {
    assertScope(scope, 'SkillRegistry.unbind')
    const normalized = normalizeSkillId(skillId)
    if (!normalized) return false
    const before = this.#db.one<{ skill_id: string }>(
      `SELECT skill_id FROM agent_skill WHERE workspace_id = ? AND agent_id = ? AND skill_id = ?`,
      [scope.workspaceId, scope.agentId, normalized],
    )
    if (!before) return false
    this.#db.run(
      `DELETE FROM agent_skill WHERE workspace_id = ? AND agent_id = ? AND skill_id = ?`,
      [scope.workspaceId, scope.agentId, normalized],
    )
    await this.#append({
      op: 'skill.unbind',
      at: this.#clock(),
      workspaceId: scope.workspaceId,
      agentId: scope.agentId,
      skillId: normalized,
    })
    return true
  }

  /** 开/关一个技能。绑定保留，只翻 enabled —— 关机再开机仍然是"关着"。 */
  async setEnabled(scope: Scope, skillId: string, enabled: boolean): Promise<SkillBinding | undefined> {
    assertScope(scope, 'SkillRegistry.setEnabled')
    const existing = this.resolveAny(scope, skillId)
    if (!existing) return undefined
    return this.bind(scope, { ...existing, enabled, grantedBy: existing.grantedBy ?? 'user' }, existing.grantedBy)
  }

  /**
   * 用一份外部清单覆盖本机绑定（快照回灌专用）。
   *
   * 语义是"对齐"而不是"追加"：清单里没有的技能会被删掉 —— 因为快照代表的是
   * 那一刻的**完整状态**，如果只做并集，用户删过的技能会在每次恢复时复活。
   *
   * 但"对齐"必须带时间守卫，否则旧快照会把用户刚改的开关打回去：本机有任何一行
   * 比 `capturedAt` 新，就整条不动（静默，这不是错误，是"这份快照过时了"）。
   * 写入行的 updated_at 用 `capturedAt` 而不是现在 —— 否则每次回灌都把技能状态
   * 盖上一个"刚刚改过"的新时间戳，下一次守卫就再也判不准了。
   */
  async replaceAll(
    scope: Scope,
    bindings: readonly SkillBindInput[],
    by: SkillGrantSource = 'snapshot',
    capturedAt?: number,
  ): Promise<number> {
    assertScope(scope, 'SkillRegistry.replaceAll')
    const desired = normalizeBindings(bindings)
    const existing = readSkillBindings(this.#db, scope)
    const at = capturedAt ?? this.#clock()
    if (existing.length > 0) {
      const newestLocal = Math.max(...existing.map((binding) => binding.updatedAt ?? 0))
      if (newestLocal > at) return 0
    }
    const desiredIds = new Set(desired.map((binding) => binding.skillId))
    let written = 0
    for (const binding of desired) {
      this.#writeRow(scope, { ...binding, grantedBy: by, updatedAt: at })
      written++
    }
    for (const stale of existing) {
      if (desiredIds.has(stale.skillId)) continue
      this.#db.run(
        `DELETE FROM agent_skill WHERE workspace_id = ? AND agent_id = ? AND skill_id = ?`,
        [scope.workspaceId, scope.agentId, stale.skillId],
      )
    }
    // 回灌是"从快照恢复"，不再往 journal 里写一条：journal 里本来就有对应的
    // skill.bind / skill.unbind，重复写会让历史无限膨胀。
    return written
  }

  /**
   * 工具层调用前的准入检查：**没挂载或已停用都返回 undefined**。
   *
   * 这是"Skill 不能越权"的最后一个闸门。即使某个调用方伪造了 skillId，
   * 只要 scope 里的 agentId 不是挂载者，这里就取不到东西。
   */
  resolve(scope: Scope, skillId: string): SkillBinding | undefined {
    assertScope(scope, 'SkillRegistry.resolve')
    const normalized = normalizeSkillId(skillId)
    if (!normalized) return undefined
    return readSkillBindings(this.#db, scope).find(
      (binding) => binding.skillId === normalized && binding.enabled,
    )
  }

  /** 同 `resolve`，但取不到就抛 —— 给"这条路径必须校验"的调用方用。 */
  requireEnabled(scope: Scope, skillId: string): SkillBinding {
    const binding = this.resolve(scope, skillId)
    if (!binding) {
      throw new SkillScopeError(
        `Agent ${scope.agentId} 在当前工作区没有启用技能 ${skillId}`,
      )
    }
    return binding
  }

  /** 按 agent 统计（只出数量，不出清单 —— 跨 Agent 查看绑定本身就该被禁止）。 */
  counts(workspaceId: string): Map<string, { total: number; enabled: number }> {
    const out = new Map<string, { total: number; enabled: number }>()
    try {
      const rows = this.#db.all<{ agent_id: string; total: number; enabled: number }>(
        `SELECT agent_id, COUNT(*) AS total, SUM(enabled) AS enabled
           FROM agent_skill WHERE workspace_id = ? GROUP BY agent_id`,
        [workspaceId],
      )
      for (const row of rows) {
        out.set(row.agent_id, { total: Number(row.total), enabled: Number(row.enabled ?? 0) })
      }
    } catch {
      /* 表还没迁移完：当作没有技能，别把面板打崩 */
    }
    return out
  }

  // ── 内部 ────────────────────────────────────────────────────────────────

  /** 含已停用条目的精确查找（setEnabled 用）。 */
  private resolveAny(scope: Scope, skillId: string): SkillBinding | undefined {
    const normalized = normalizeSkillId(skillId)
    if (!normalized) return undefined
    return readSkillBindings(this.#db, scope).find((binding) => binding.skillId === normalized)
  }

  #writeRow(scope: Scope, binding: SkillBinding): void {
    this.#db.run(
      `INSERT INTO agent_skill (agent_id, workspace_id, skill_id, version, enabled, config, granted_by, updated_at)
       VALUES (?,?,?,?,?,?,?,?)
       ON CONFLICT(agent_id, workspace_id, skill_id) DO UPDATE SET
         version    = excluded.version,
         enabled    = excluded.enabled,
         config     = excluded.config,
         granted_by = excluded.granted_by,
         updated_at = excluded.updated_at`,
      [
        scope.agentId,
        scope.workspaceId,
        binding.skillId,
        binding.version ?? '',
        binding.enabled ? 1 : 0,
        JSON.stringify(binding.config ?? {}),
        binding.grantedBy ?? 'user',
        binding.updatedAt ?? this.#clock(),
      ],
    )
  }

  async #append(input: Record<string, unknown> & { op: string }): Promise<void> {
    if (!this.#journal) return
    try {
      await this.#journal.append(input)
    } catch (error) {
      // 落盘失败不回滚内存态：本机仍然是"挂上了"，但要让人知道它不会漫游。
      this.#onWarn(`技能变更未写入 journal，可能无法漫游：${describe(error)}`)
    }
  }
}

/** 作用域锁死的读取入口（HTTP 层 / 快照采集复用同一份 SQL）。 */
export function readSkillBindings(db: SqlDriver, scope: Scope): SkillBinding[] {
  try {
    const rows = db.all<SkillRow>(
      `SELECT skill_id, version, enabled, config, granted_by, updated_at
         FROM agent_skill WHERE workspace_id = ? AND agent_id = ?
        ORDER BY skill_id`,
      [scope.workspaceId, scope.agentId],
    )
    return rows.map((row) => ({
      skillId: row.skill_id,
      version: row.version === '' ? undefined : row.version,
      enabled: Number(row.enabled) === 1,
      config: parseConfig(row.config),
      grantedBy: toGrantSource(row.granted_by),
      updatedAt: row.updated_at,
    }))
  } catch {
    return []
  }
}

function parseConfig(raw: string): Record<string, unknown> | undefined {
  try {
    const parsed: unknown = JSON.parse(raw || '{}')
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return undefined
    return Object.keys(parsed as Record<string, unknown>).length === 0
      ? undefined
      : (parsed as Record<string, unknown>)
  } catch {
    return undefined
  }
}

/**
 * 只数个数，不返回清单。
 *
 * 总览页需要"这个 Agent 挂了几个技能"，但跨 Agent 的技能清单本身是信息泄漏
 * （能看出别人装了什么、开没开），所以对外只给数字。仍然是 (workspace, agent)
 * 双条件，不是"按工作区 group by"。
 */
export function countSkills(db: SqlDriver, scope: Scope): number {
  try {
    const row = db.one<{ n: number }>(
      `SELECT COUNT(*) AS n FROM agent_skill WHERE workspace_id = ? AND agent_id = ? AND enabled = 1`,
      [scope.workspaceId, scope.agentId],
    )
    return Number(row?.n ?? 0)
  } catch {
    return 0
  }
}

function toGrantSource(raw: string): SkillGrantSource {
  return raw === 'agent' || raw === 'snapshot' ? raw : 'user'
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
