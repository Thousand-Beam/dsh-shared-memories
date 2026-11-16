/**
 * dsh-shared-memories — 技能回灌（skill rehydrate）
 * ---------------------------------------------------------------------------
 * 冷启动恢复的"能力"那一半。
 *
 * 记忆由 journal 重放，人格由 `persona/*.json` 回灌，技能由 `state/skills.json`
 * 回灌。三个来源、三条路径，缺任何一条，"全状态漫游"就在那个维度上漏了：
 *
 *   - 少了技能：设备 B 上记忆还在，但 A 的 `code-exec` 不见了 —— 模型突然"不会"
 *     它本来会的事，而且没有任何报错，只是行为退化。这是最难发现的一类丢失。
 *
 * 语义要点（和人格回灌刻意不同）：
 *   - 人格是**补全**（只在缺的时候插，不覆盖本机更新的），因为人格是渐进演化的；
 *   - 技能是**对齐**（清单即真相，多出来的删掉），因为"技能开关"是一个明确状态：
 *     用户在 A 上关掉了 `web-search`，B 机恢复后不能自作主张把它打开。
 *
 * 容错：`state/skills.json` 是可选的（老快照没有）。文件不存在时**什么都不做**，
 * 绝不清空本机已有绑定 —— "没记录"不等于"没有技能"。
 */

import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { Scope } from '../../shared/scope.js'
import type { SkillBindInput } from '../../shared/skills.js'
import { normalizeSkillId, normalizeSkillVersion } from '../../shared/skills.js'
import type { SqlDriver } from '../../shared/types.js'
import { SkillRegistry } from '../memory/skill-registry.js'

/** `state/skills.json` 的结构（与 SnapshotEngine.#writeSkillState 一一对应）。 */
export interface SkillsStateFile {
  version?: number
  device?: string
  capturedAt?: number
  agents?: {
    agentId?: string
    workspaceIds?: string[]
    skills?: {
      skillId?: string
      version?: string
      enabled?: boolean
      config?: Record<string, unknown>
      grantedBy?: string
    }[]
  }[]
}

export interface SkillRehydrateResult {
  /** 磁盘上有没有 skills.json（false = 老快照 / 从未快照过，调用方不该清空任何东西）。 */
  readonly present: boolean
  /** 认到的 agent 数量。 */
  readonly agents: number
  /** 实际写进 agent_skill 的绑定条数。 */
  readonly bindings: number
  /** 写入失败的 (agent, workspace) 组合数（只告警）。 */
  readonly failed: number
}

const FALLBACK_WORKSPACE = 'unknown'

export async function rehydrateSkillsFromRepo(options: {
  db: SqlDriver
  root: string
  clock?: () => number
  onWarn?: (message: string) => void
}): Promise<SkillRehydrateResult> {
  const onWarn = options.onWarn ?? (() => {})
  const empty: SkillRehydrateResult = { present: false, agents: 0, bindings: 0, failed: 0 }

  let pointer: SkillsStateFile
  try {
    const raw = await readFile(join(options.root, 'state', 'skills.json'), 'utf8')
    pointer = JSON.parse(raw) as SkillsStateFile
  } catch {
    // 老快照 / 纯本地首次启动：没有这个文件是正常的，保持本机现状。
    return empty
  }

  const registry = new SkillRegistry({
    db: options.db,
    clock: options.clock,
    onWarn,
  })
  const agents = Array.isArray(pointer.agents) ? pointer.agents : []
  let bindings = 0
  let failed = 0
  for (const entry of agents) {
    const agentId = (entry.agentId ?? '').trim()
    if (!agentId) continue
    const workspaces = entry.workspaceIds?.length ? entry.workspaceIds : [FALLBACK_WORKSPACE]
    const desired: SkillBindInput[] = (entry.skills ?? [])
      .map((skill) => ({
        skillId: normalizeSkillId(skill.skillId),
        version: normalizeSkillVersion(skill.version),
        enabled: skill.enabled !== false,
        config: skill.config,
      }))
      .filter((skill) => skill.skillId !== '')
    for (const workspaceId of workspaces) {
      const scope: Scope = { workspaceId, agentId }
      try {
        bindings += await registry.replaceAll(scope, desired, 'snapshot')
      } catch (error) {
        failed++
        onWarn(`回灌技能失败（${agentId}@${workspaceId}）：${describe(error)}`)
      }
    }
  }
  return { present: true, agents: agents.length, bindings, failed }
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
