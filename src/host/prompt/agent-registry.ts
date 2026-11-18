/**
 * dsh-shared-memories — 多智能体注册表（AgentRegistry）
 * ---------------------------------------------------------------------------
 * 多智能体需求的中枢：
 *   - 每个 `agent_id` 在每个 `workspace_id` 下有一份**独立人格**（persona_state 表）；
 *   - 切换活跃 agent 时，记忆作用域（Scope）随之切换，并通知订阅者重建提示；
 *   - 特质只做**微移**：单次偏移被 `traitShiftMax` 夹住（默认 0.05），
 *     所以人格是"沿连续轴慢慢漂"，不会一轮对话就换了个人。
 *
 * 这里不做 I/O 之外的事情：真正的 System Prompt 刷新由 index.ts 订阅 onSwitch 之后
 * 用 buildPrompt 组装完成，保持职责单一。
 */

import type { Scope } from '../../shared/scope.js'
import { assertScope } from '../../shared/scope.js'
import type { SqlDriver } from '../../shared/types.js'

export interface AgentRecord {
  readonly agentId: string
  readonly workspaceId: string
  readonly name: string
  readonly age: number
  readonly traits: Readonly<Record<string, number>>
  readonly baselineHash: string
  readonly updatedAt: number
}

export interface AgentRegistryOptions {
  readonly db: SqlDriver
  /** 单次特质漂移上限，默认 0.05。 */
  readonly traitShiftMax?: number
  /** 默认年龄心智（零预设起点：10 岁探索者）。 */
  readonly defaultAge?: number
  readonly clock?: () => number
  readonly onWarn?: (message: string) => void
}

export class AgentRegistry {
  readonly #db: SqlDriver
  readonly #shiftMax: number
  readonly #defaultAge: number
  readonly #clock: () => number
  readonly #onWarn: (message: string) => void
  readonly #listeners = new Set<(record: AgentRecord) => void>()
  #active: AgentRecord | undefined

  constructor(options: AgentRegistryOptions) {
    this.#db = options.db
    this.#shiftMax = options.traitShiftMax ?? 0.05
    this.#defaultAge = options.defaultAge ?? 10
    this.#clock = options.clock ?? Date.now
    this.#onWarn = options.onWarn ?? (() => {})
  }

  /** 注册（或补全）一个 agent 的人格档案。已存在则只补缺失字段。 */
  register(input: {
    agentId: string
    workspaceId: string
    name?: string
    age?: number
    traits?: Record<string, number>
    baselineHash?: string
  }): AgentRecord {
    const scope: Scope = { workspaceId: input.workspaceId, agentId: input.agentId }
    assertScope(scope, 'AgentRegistry.register')
    const existing = this.get(input.agentId, input.workspaceId)
    const now = this.#clock()
    const merged: AgentRecord = {
      agentId: input.agentId,
      workspaceId: input.workspaceId,
      name: input.name ?? existing?.name ?? input.agentId,
      age: input.age ?? existing?.age ?? this.#defaultAge,
      traits: { ...(existing?.traits ?? {}), ...(input.traits ?? {}) },
      baselineHash: input.baselineHash ?? existing?.baselineHash ?? '',
      updatedAt: now,
    }
    this.#db.run(
      `INSERT INTO persona_state (agent_id, workspace_id, name, age, traits, baseline_hash, updated_at)
       VALUES (?,?,?,?,?,?,?)
       ON CONFLICT(agent_id, workspace_id) DO UPDATE SET
         name = excluded.name,
         age = excluded.age,
         traits = excluded.traits,
         baseline_hash = excluded.baseline_hash,
         updated_at = excluded.updated_at`,
      [
        merged.agentId,
        merged.workspaceId,
        merged.name,
        merged.age,
        JSON.stringify(merged.traits),
        merged.baselineHash,
        now,
      ],
    )
    return merged
  }

  /**
   * 特质微移。`shift` 里每个值是**本轮的期望偏移**（可正可负），
   * 实际应用前先夹到 ±traitShiftMax，再夹到 [0,1]。
   */
  shiftTraits(input: {
    agentId: string
    workspaceId: string
    shift: Record<string, number>
  }): AgentRecord {
    const current = this.get(input.agentId, input.workspaceId) ?? this.register(input)
    const traits: Record<string, number> = { ...current.traits }
    for (const [key, delta] of Object.entries(input.shift)) {
      const numeric = Number(delta)
      if (!Number.isFinite(numeric)) continue
      const bounded = Math.max(-this.#shiftMax, Math.min(this.#shiftMax, numeric))
      const base = traits[key] ?? 0.5
      traits[key] = Math.min(1, Math.max(0, base + bounded))
    }
    return this.register({
      agentId: input.agentId,
      workspaceId: input.workspaceId,
      traits,
      name: current.name,
      age: current.age,
      baselineHash: current.baselineHash,
    })
  }

  get(agentId: string, workspaceId: string): AgentRecord | undefined {
    try {
      const row = this.#db.one<{
        agent_id: string
        workspace_id: string
        name: string
        age: number
        traits: string
        baseline_hash: string
        updated_at: number
      }>(
        `SELECT agent_id, workspace_id, name, age, traits, baseline_hash, updated_at
           FROM persona_state WHERE agent_id = ? AND workspace_id = ?`,
        [agentId, workspaceId],
      )
      if (!row) return undefined
      return {
        agentId: row.agent_id,
        workspaceId: row.workspace_id,
        name: row.name || row.agent_id,
        age: row.age,
        traits: parseTraits(row.traits),
        baselineHash: row.baseline_hash,
        updatedAt: row.updated_at,
      }
    } catch (error) {
      this.#onWarn(`读取人格失败：${error instanceof Error ? error.message : String(error)}`)
      return undefined
    }
  }

  /** 某个工作区下所有已知 agent（UI 的 Agent Switcher 数据源）。 */
  list(workspaceId?: string): AgentRecord[] {
    try {
      const rows = this.#db.all<{
        agent_id: string
        workspace_id: string
        name: string
        age: number
        traits: string
        baseline_hash: string
        updated_at: number
      }>(
        workspaceId
          ? `SELECT * FROM persona_state WHERE workspace_id = ? ORDER BY updated_at DESC`
          : `SELECT * FROM persona_state ORDER BY updated_at DESC`,
        workspaceId ? [workspaceId] : [],
      )
      return rows.map((row) => ({
        agentId: row.agent_id,
        workspaceId: row.workspace_id,
        name: row.name || row.agent_id,
        age: row.age,
        traits: parseTraits(row.traits),
        baselineHash: row.baseline_hash,
        updatedAt: row.updated_at,
      }))
    } catch (error) {
      this.#onWarn(`列举人格失败：${error instanceof Error ? error.message : String(error)}`)
      return []
    }
  }

  /** 切换活跃 agent：后续所有记忆读写都用它的 Scope。 */
  setActive(agentId: string, workspaceId: string): AgentRecord {
    const record = this.get(agentId, workspaceId) ?? this.register({ agentId, workspaceId })
    this.#active = record
    for (const listener of this.#listeners) {
      try {
        listener(record)
      } catch (error) {
        this.#onWarn(`切换订阅者报错：${error instanceof Error ? error.message : String(error)}`)
      }
    }
    return record
  }

  active(): AgentRecord | undefined {
    return this.#active
  }

  /** 当前活跃作用域；没有活跃 agent 时返回 undefined（调用方应拒绝写记忆）。 */
  currentScope(): Scope | undefined {
    if (!this.#active) return undefined
    return { workspaceId: this.#active.workspaceId, agentId: this.#active.agentId }
  }

  /** 订阅切换事件，返回取消订阅函数（给 ctx.effect 用，天然可清理）。 */
  subscribe(listener: (record: AgentRecord) => void): () => void {
    this.#listeners.add(listener)
    return () => {
      this.#listeners.delete(listener)
    }
  }
}

function parseTraits(raw: string): Record<string, number> {
  try {
    const parsed: unknown = JSON.parse(raw || '{}')
    if (typeof parsed !== 'object' || parsed === null) return {}
    const out: Record<string, number> = {}
    for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
      const numeric = Number(value)
      if (Number.isFinite(numeric)) out[key] = Math.min(1, Math.max(0, numeric))
    }
    return out
  } catch {
    return {}
  }
}
