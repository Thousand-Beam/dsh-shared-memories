/**
 * dsh-shared-memories — 控制台 API 契约（host 与 client 共用）
 * ---------------------------------------------------------------------------
 * 这一层存在的唯一理由：**别让服务端和前端各写一份 DTO**。
 * 上一版是 routes.ts 直接 import `src/client/state.ts` 的类型——那意味着
 * 服务端的编译单元反向依赖前端编译单元，一旦 client 的 tsconfig 加了
 * `"lib": ["DOM"]` 或者 jsx，host 侧的构建就会连带被拖进来。
 *
 * 现在两边都只依赖这里。改字段 = 改一处，`tsc` 会把两端一起报错。
 */

export interface AgentSummary {
  agentId: string
  workspaceId: string
  name: string
  age: number
  traits: Record<string, number>
  /** 当前工作区下这个 Agent 挂载的技能数（0 表示没挂，undefined 表示老版本宿主没算）。 */
  skillCount?: number
  /** 这个 Agent 名下的活跃记忆条数（用于排序：默认选中"真的在用"的那个人格）。 */
  memoryCount?: number
  /** 这个 Agent 由几个会话共用（≥2 = 换会话会继承，1 = 就一个会话）。 */
  sessionCount?: number
}

/** 一条会话 → 人格 的绑定（控制台"这个 Agent 由几个会话共用"的依据）。 */
export interface SessionAliasDto {
  agentId: string
  personaId: string
  boundAt: number
  lastSeenAt: number
}

/** 一个人格 + 它名下的会话数。 */
export interface PersonaSummaryDto {
  personaId: string
  sessionCount: number
  lastSeenAt: number
}

/** 身份绑定总览。 */
export interface IdentityBundle {
  workspaceId: string
  personas: PersonaSummaryDto[]
  sessions: SessionAliasDto[]
}

/**
 * 技能绑定的对外形状。
 *
 * 故意**不含** `config` 的具体内容：技能参数里可能有 token / 路径 / 私有地址，
 * 控制台只需要知道"挂了什么、开没开"，改参数应当走各技能自己的配置入口。
 */
export interface SkillBindingDto {
  skillId: string
  version: string
  enabled: boolean
  grantedBy: string
  updatedAt: number
}

export interface SkillsBundle {
  agentId: string
  workspaceId: string
  items: SkillBindingDto[]
}

/**
 * 用户画像 DTO。
 *
 * 带一个算好的 `address`：有效称呼（preferredAddress 优先，否则 displayName）。
 * 前端与提示层用同一个字段，避免两处各算一遍导致"界面叫老张、提示叫张三"。
 */
export interface UserProfileDto {
  workspaceId: string
  displayName: string
  preferredAddress: string
  address: string
  notes: string
  updatedAt: number
  updatedBy: string
}

export interface MemoryCard {
  entityId: string
  versionId: string
  kind: string
  subjectKey: string
  text: string
  workspaceId: string
  agentId: string
  trust: number
  salience: number
  status: 'active' | 'merged' | 'quarantined' | 'forgotten'
  distillStatus: 'raw' | 'distilled' | 'failed' | 'merged'
  validFrom: number
  emotion: { label: string; subject: string; trigger: string; intensity: number } | null
}

export interface SnapshotNode {
  snapshotId: string
  createdAt: number
  device: string
  trigger: 'interval' | 'idle' | 'shutdown' | 'manual' | 'pre-rollback'
  commit?: string
  tag?: string
  pinned: boolean
  summary: string
  files: number
  bytes: number
}

export interface QuarantineItem {
  quarantineId: string
  reason: string
  score: number
  payload: string
  createdAt: number
}

/** 恢复闸门阶段（host 的 RestorePhase 与这里必须逐字一致）。 */
export type RestorePhase = 'cold' | 'pulling' | 'verifying' | 'replaying' | 'ready' | 'degraded'

/** `GET /state` 的响应：控制台开机第一发请求。 */
export interface ConsoleBootstrap {
  phase: RestorePhase
  phaseDetail: string
  agents: AgentSummary[]
  activeAgentId: string
  snapshotKeep: number
  allowGlobalSearch: boolean
  workspaceId: string
  deviceId: string
}

/** 人格文档：`baselineHash` 是「底线声明」的指纹，UI 用它显示那把锁。 */
export interface PersonaDoc {
  agentId: string
  workspaceId: string
  name: string
  age: number
  traits: Record<string, number>
  baselineHash: string
  updatedAt: number
}

export type RuleStage = 'observation' | 'lesson' | 'pattern' | 'rule'

/**
 * 踩坑链的一条。
 * 故意用 camelCase 且 `confirmed` 用 boolean：host 侧那张表的 snake_case 与
 * `confirmed: 0|1` 属于存储细节，不该漏到前端（漏出去以后每改一次表就改一次 UI）。
 */
export interface RuleItem {
  pitfallId: string
  observation: string
  lesson: string
  pattern: string
  rule: string
  stage: RuleStage
  confirmed: boolean
  occurrences: number
  updatedAt: number
}

/** 待确认的升格请求（带 TTL，过期即作废）。 */
export interface PromotionPreview {
  requestId: string
  pitfallId: string
  to: RuleStage
  preview: { observation: string; lesson: string; pattern: string; rule: string }
  expiresAt: number
}

export interface RulesBundle {
  items: RuleItem[]
  pending: PromotionPreview[]
}
