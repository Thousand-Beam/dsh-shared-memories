/**
 * 会话策略：无痕模式 + 归档提取策略。
 * ---------------------------------------------------------------------------
 * 这两件事本质是同一张表上的两个开关，所以放一起：
 *
 *   - `ephemeral`（无痕）：这段对话**什么都不留**——不蒸馏、不写记忆、不进快照。
 *     用户的心理预期是"关掉窗口就灰飞烟灭"，所以这道闸必须卡在写入前，
 *     而不是写完再删（写完再删会留下 journal 记录，等于留了痕）。
 *   - `archiveMode`（归档策略）：DSH 原生"归档会话"时要不要顺手提取记忆。
 *        off          仅归档对话，绝不进 memory_entity
 *        incremental  只提炼这次归档时新增的部分
 *        deep         从头到尾重读一遍，Map-Reduce 全量固化
 *
 * 键是 `sessionId`：DSH 里 agent.id === session.id，一个会话就是一个易变 id，
 * 所以策略必须挂在 session 上，而不是挂在稳定人格上（否则换了会话还带着无痕标记）。
 */

export const ARCHIVE_MODES = ['off', 'incremental', 'deep'] as const

export type ArchiveMode = (typeof ARCHIVE_MODES)[number]

export interface SessionPolicy {
  readonly sessionId: string
  readonly workspaceId: string
  /** 解析后的人格 id，仅用于展示与清理，不做读取主键。 */
  readonly agentId: string
  /** 无痕：该会话不产生任何持久化副作用。 */
  readonly ephemeral: boolean
  readonly archiveMode: ArchiveMode
  readonly updatedAt: number
}

export interface SessionPolicyInput {
  readonly ephemeral?: boolean
  readonly archiveMode?: ArchiveMode
}

export const DEFAULT_ARCHIVE_MODE: ArchiveMode = 'incremental'

export const EMPTY_POLICY: Omit<SessionPolicy, 'sessionId' | 'workspaceId' | 'agentId'> = {
  ephemeral: false,
  archiveMode: DEFAULT_ARCHIVE_MODE,
  updatedAt: 0,
}

export function isArchiveMode(value: unknown): value is ArchiveMode {
  return typeof value === 'string' && (ARCHIVE_MODES as readonly string[]).includes(value)
}

export function normalizePolicyInput(input: SessionPolicyInput): SessionPolicyInput {
  const next: { ephemeral?: boolean; archiveMode?: ArchiveMode } = {}
  if (typeof input.ephemeral === 'boolean') next.ephemeral = input.ephemeral
  if (isArchiveMode(input.archiveMode)) next.archiveMode = input.archiveMode
  return next
}

export const ARCHIVE_MODE_LABEL: Record<ArchiveMode, string> = {
  off: '仅归档对话',
  incremental: '归档 + 增量提取',
  deep: '归档 + 深度重读',
}

export const ARCHIVE_MODE_HINT: Record<ArchiveMode, string> = {
  off: '对话历史留在本地，但一条记忆都不会生成',
  incremental: '只提炼这次新增的部分，快、省 Token',
  deep: '从头重读整个会话，分块提取后归并，慢但最完整',
}

/** 控制台用的形状：把"会话"与"当前是否无痕/归档策略"一起给前端。 */
export interface SessionPolicyDto {
  readonly sessionId: string
  readonly ephemeral: boolean
  readonly archiveMode: ArchiveMode
  readonly archiveModeLabel: string
  readonly archiveModeHint: string
  readonly updatedAt: number
}

export function toPolicyDto(policy: SessionPolicy): SessionPolicyDto {
  return {
    sessionId: policy.sessionId,
    ephemeral: policy.ephemeral,
    archiveMode: policy.archiveMode,
    archiveModeLabel: ARCHIVE_MODE_LABEL[policy.archiveMode],
    archiveModeHint: ARCHIVE_MODE_HINT[policy.archiveMode],
    updatedAt: policy.updatedAt,
  }
}

/** 提炼任务进度（前端轮询用）。 */
export interface DistillJobDto {
  readonly jobId: string
  readonly sessionId: string
  readonly mode: 'incremental' | 'deep'
  readonly status: 'running' | 'done' | 'failed' | 'skipped'
  readonly phase: string
  readonly detail: string
  readonly chunk: number
  readonly total: number
  readonly turns: number
  readonly written: number
  readonly startedAt: number
  readonly updatedAt: number
  readonly error?: string
}
