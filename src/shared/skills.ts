/**
 * dsh-shared-memories — Skill 绑定（skills.ts）
 * ---------------------------------------------------------------------------
 * 这里解决的是"多智能体的技能隔离"里**最容易被忽略的一半**：
 *
 *   Agent 有记忆，Agent 也有**能力**。记忆早就按 (workspace, agent) 隔离了，
 *   但"谁能用哪个工具"如果只活在本机的宿主配置里，换台机器就全丢了 ——
 *   于是"全状态漫游"在工具维度上直接破功：记忆跟着人走了，能力没走。
 *
 * 两条设计边界，先说清楚，免得实现跑偏：
 *
 *   1. **我们只漫游"绑定关系"，不漫游技能本体。**
 *      技能代码是宿主（或插件包）提供的，把它复制进 git 既不安全也没意义
 *      （版本、签名、权限都不归我们管）。我们记的是：谁挂了什么、什么版本、
 *      开着还是关着、参数是什么。恢复时宿主照着这张表把技能挂回去。
 *
 *   2. **绑定的作用域和记忆完全同构**：`(workspace_id, agent_id)`。
 *      不是"全局技能池 + 运行时过滤"，而是"每个 Agent 在每个工作区各有一份"。
 *      这样 A 有代码执行、B 只有网页搜索，两者在数据库层面就互不可见。
 */

/** 一条技能绑定。`config` 必须是纯 JSON——它要进 journal 和快照文件。 */
export interface SkillBinding {
  readonly skillId: string
  /** 技能版本（可选）。恢复时宿主可以据此判断要不要升级/降级。 */
  readonly version?: string
  /** 关掉但保留绑定：换机后仍然是"关着"，而不是"没挂过"。 */
  readonly enabled: boolean
  readonly config?: Readonly<Record<string, unknown>>
  /** 谁挂的：用户手动挂 / Agent 自己挂 / 从快照回灌。 */
  readonly grantedBy?: SkillGrantSource
  readonly updatedAt?: number
}

export type SkillGrantSource = 'user' | 'agent' | 'snapshot'

/** 绑定/解绑的输入。 */
export interface SkillBindInput {
  readonly skillId: string
  readonly version?: string
  readonly enabled?: boolean
  readonly config?: Readonly<Record<string, unknown>>
  readonly grantedBy?: SkillGrantSource
}

/**
 * 技能 id 允许的字符集：小写字母数字打头，后面允许 `._-`。
 *
 * 为什么卡这么死：id 会进 journal 行、进 `state/skills.json`、进 System Prompt。
 * 放开任意字符就等于给"注入一段提示词当技能名"开了口子。
 */
const SKILL_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/

/** 校验并归一化技能 id；不合法返回空串（调用方按"忽略这一条"处理）。 */
export function normalizeSkillId(raw: unknown): string {
  if (typeof raw !== 'string') return ''
  const trimmed = raw.trim()
  return SKILL_ID_PATTERN.test(trimmed) ? trimmed : ''
}

/** 版本号只做展示与告警，不参与比较；空/超长一律截断。 */
export function normalizeSkillVersion(raw: unknown): string | undefined {
  if (typeof raw !== 'string') return undefined
  const trimmed = raw.trim()
  return trimmed === '' ? undefined : trimmed.slice(0, 32)
}

/**
 * 归一化一批绑定：校验 id、按 id 去重（后者覆盖前者）、按 id 排序。
 *
 * 排序是必须的：快照文件的 sha256 会进清单，顺序不稳定 = 每次快照都"有改动"，
 * git 历史会被无意义的 diff 灌满。
 */
export function normalizeBindings(input: readonly SkillBindInput[]): SkillBinding[] {
  const byId = new Map<string, SkillBinding>()
  for (const item of input) {
    const skillId = normalizeSkillId(item.skillId)
    if (!skillId) continue
    byId.set(skillId, {
      skillId,
      version: normalizeSkillVersion(item.version),
      enabled: item.enabled !== false,
      config: isPlainObject(item.config) ? item.config : undefined,
      grantedBy: item.grantedBy ?? 'user',
    })
  }
  return [...byId.values()].sort((a, b) => (a.skillId < b.skillId ? -1 : a.skillId > b.skillId ? 1 : 0))
}

/** 只取启用的那些（注入提示、给工具层挂载时用）。 */
export function enabledSkills(bindings: readonly SkillBinding[]): SkillBinding[] {
  return bindings.filter((binding) => binding.enabled)
}

/**
 * 渲染成提示词里的几行。
 *
 * 措辞上的两个刻意选择：
 *   - 明说"只列你自己挂载的"，因为模型很容易把"隔壁 Agent 能用"当成自己能用；
 *   - 关掉的技能也列出来并标 `已停用`，否则模型会尝试调用一个被用户关掉的工具，
 *     然后困惑于"为什么调不通"。
 */
export function renderSkillLines(bindings: readonly SkillBinding[], limit = 12): string[] {
  if (bindings.length === 0) return []
  const shown = [...bindings].sort((a, b) => Number(b.enabled) - Number(a.enabled)).slice(0, limit)
  const lines = shown.map((binding) => {
    const version = binding.version ? ` ${binding.version}` : ''
    const state = binding.enabled ? '可用' : '已停用'
    return `- \`${binding.skillId}\`${version} · ${state}`
  })
  if (bindings.length > shown.length) {
    lines.push(`- （另有 ${bindings.length - shown.length} 个技能未列出）`)
  }
  return lines
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
