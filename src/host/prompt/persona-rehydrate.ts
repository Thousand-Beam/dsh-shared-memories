/**
 * dsh-shared-memories — 人格回灌（persona rehydrate）
 * ---------------------------------------------------------------------------
 * 冷启动恢复的"多智能体"那一半。
 *
 * 记忆是 journal 重放回来的，但**人格（persona_state）不是记忆**：它存在 SQLite
 * 里，SQLite 又不进 git。所以如果只重放 journal，设备 B 开机后会看到"记忆都在，
 * 但下拉框里一个 Agent 都没有"。
 *
 * 解决办法：快照时把所有 agent 的人格写成 `persona/<agentId>.json`，并把
 * agentId / workspaceIds / sessions 指针写进 `state/agents.json`（见
 * SnapshotEngine.#materializeState）。恢复时读这两个文件回灌数据库——
 * 这就是"所有 Agent 的上下文指针"能跨设备带走的原因。
 *
 * 容错原则：这两个文件是**可选**的（老版本快照里没有）。读不到就静默跳过，
 * 绝不能因为缺人格文件就把整个恢复流程打成 degraded。
 */

import { readFile, readdir } from 'node:fs/promises'
import { join } from 'node:path'
import type { SqlDriver } from '../../shared/types.js'
import { mergeByKey, readStateFiles } from './state-read.js'

/** agents.json 里单个 agent 的指针（与 SnapshotEngine 写出的格式一一对应）。 */
export interface AgentPointerEntry {
  agentId?: string
  workspaceIds?: string[]
  sessions?: string[]
  hasPersona?: boolean
  skillCount?: number
  enabledSkillIds?: string[]
}

/** agents.json 的结构。 */
export interface AgentsPointerFile {
  version: number
  device?: string
  capturedAt?: number
  agents?: AgentPointerEntry[]
}

export interface RehydrateResult {
  /** agents.json 里认到的 agent 数量。 */
  readonly agents: number
  /** 真正写进 persona_state 的 (agent, workspace) 行数。 */
  readonly personas: number
  /** 读人格文件失败的条目数（只告警，不影响恢复）。 */
  readonly failed: number
}

/** 没有 workspaceId 的兜底作用域：宁可归到一个"未知工作区"，也不要丢掉这个人格。 */
const FALLBACK_WORKSPACE = 'unknown'

export async function rehydratePersonaFromRepo(options: {
  db: SqlDriver
  root: string
  clock?: () => number
  onWarn?: (message: string) => void
}): Promise<RehydrateResult> {
  const onWarn = options.onWarn ?? (() => {})
  const now = options.clock?.() ?? Date.now()

  // 多设备格式：state/<deviceId>/agents.json 每台设备一份，按 agentId LWW 合并；
  // 老单文件格式：state/agents.json（readStateFiles 兜底读）。
  const collection = await readStateFiles(options.root, 'agents.json', onWarn)
  if (collection.parsed.length === 0) {
    // 老快照 / 纯本地首次启动：没有这个文件是正常的；文件在但坏了 = 上报失败。
    return { agents: 0, personas: 0, failed: collection.failures }
  }
  const merged = mergeByKey(
    collection.parsed,
    (chunk) => {
      const file = chunk as unknown as AgentsPointerFile
      return Array.isArray(file.agents) ? file.agents ?? [] : []
    },
    (entry) => (entry.agentId ?? '').trim(),
  )
  const agents = [...merged.values()]
  let personas = 0
  let failed = 0
  for (const entry of agents) {
    const agentId = (entry.agentId ?? '').trim()
    if (!agentId) continue
    const persona = await readPersonaFile(options.root, agentId, onWarn)
    if (!persona) failed++
    const workspaces = entry.workspaceIds?.length ? entry.workspaceIds : [FALLBACK_WORKSPACE]
    for (const workspaceId of workspaces) {
      const name = str(persona?.name) ?? agentId
      const age = num(persona?.age) ?? 10
      const traits = isRecord(persona?.traits) ? JSON.stringify(persona.traits) : '{}'
      const baselineHash = str(persona?.baselineHash) ?? ''
      try {
        // 不用 INSERT OR REPLACE：本机已有的人格可能比快照里的更新（用户本轮改过），
        // 以 updated_at 较新者为准，避免开机被旧快照覆盖。
        options.db.run(
          `INSERT INTO persona_state (agent_id, workspace_id, name, age, traits, baseline_hash, updated_at)
           VALUES (?,?,?,?,?,?,?)
           ON CONFLICT(agent_id, workspace_id) DO UPDATE SET
             name = excluded.name,
             age = excluded.age,
             traits = excluded.traits,
             baseline_hash = excluded.baseline_hash,
             updated_at = MAX(persona_state.updated_at, excluded.updated_at)
           WHERE excluded.updated_at >= persona_state.updated_at`,
          [agentId, workspaceId, name, age, traits, baselineHash, num(persona?.updatedAt) ?? now],
        )
        personas++
      } catch (error) {
        failed++
        onWarn(`回灌人格失败（${agentId}@${workspaceId}）：${describe(error)}`)
      }
    }
  }
  return { agents: agents.length, personas, failed: failed + collection.failures }
}

/** 读取单人份人格文件；文件名做了消毒，所以这里也要按同一规则找。 */
async function readPersonaFile(
  root: string,
  agentId: string,
  onWarn: (message: string) => void,
): Promise<Record<string, unknown> | undefined> {
  const dir = join(root, 'persona')
  const direct = join(dir, `${sanitizeName(agentId)}.json`)
  try {
    return JSON.parse(await readFile(direct, 'utf8')) as Record<string, unknown>
  } catch {
    /* 落到下面的模糊匹配 */
  }
  try {
    const files = await readdir(dir)
    const hit = files.find((file) => file.replace(/\.json$/, '') === sanitizeName(agentId))
    if (!hit) return undefined
    return JSON.parse(await readFile(join(dir, hit), 'utf8')) as Record<string, unknown>
  } catch (error) {
    onWarn(`读取人格文件失败（${agentId}）：${describe(error)}`)
    return undefined
  }
}

function sanitizeName(value: string): string {
  return value.replace(/[^0-9A-Za-z._-]/g, '_').slice(0, 120) || 'anonymous'
}

function str(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined
}

function num(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
