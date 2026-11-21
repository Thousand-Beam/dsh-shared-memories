/**
 * dsh-shared-memories — 控制台 API 客户端（client/api.ts）
 * ---------------------------------------------------------------------------
 * 所有请求都走宿主插件注册的 HTTP 路由（前缀 `/dsh/shared-memories`）。
 * 统一在这里做三件事：拼 URL、解包 `{ok,data,error}`、把网络异常转成可展示文案。
 *
 * 注意：不在这里存 token、不读 localStorage。令牌只存在于当前页面内存，
 * 由 `ConsoleStore` 持有——这是"全局检索必须显式授权"的一部分。
 */

import type { ArchiveMode, DistillJobDto, SessionPolicyDto } from '../shared/session-policy.js'
import type {
  AgentSummary,
  ConsoleBootstrap,
  MemoryCard,
  PersonaDoc,
  PromotionPreview,
  QuarantineItem,
  RestorePhase,
  RuleItem,
  RulesBundle,
  RuleStage,
  SnapshotNode,
  UserProfileDto,
} from './state.js'

const BASE = '/dsh/shared-memories'

export interface ApiError {
  code: string
  message: string
  /** 非 2xx 响应体里 `data` 字段（例如 /save 409 时带 snapshotId/pushed/pushReason）。 */
  data?: unknown
}

/** doctor 自检报告（前端展示用，与 src/host/doctor.ts 的 DoctorReport 对齐）。 */
export interface DoctorFindingDto {
  id: string
  severity: 'ok' | 'warn' | 'error'
  title: string
  detail: string
  fix?: string
}
export interface DoctorReportDto {
  ok: boolean
  summary: { ok: number; warn: number; error: number }
  environment: {
    node: string
    git: string
    dataRoot: string
    snapshots: number
    commits: number
    journalBytes: number
  }
  findings: DoctorFindingDto[]
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  let response: Response
  try {
    response = await fetch(`${BASE}${path}`, {
      headers: { 'content-type': 'application/json', ...(init?.headers ?? {}) },
      ...init,
    })
  } catch (error) {
    throw toApiError('network-unreachable', error)
  }
  const text = await response.text()
  const payload = text ? (safeJson(text) as { ok?: boolean; data?: unknown; error?: ApiError }) : {}
  if (!response.ok || payload.ok === false) {
    const err: ApiError = payload.error ?? { code: `http-${response.status}`, message: text.slice(0, 300) }
    if (payload.data !== undefined) err.data = payload.data
    throw err
  }
  return payload.data as T
}

export type { ConsoleBootstrap } from '../shared/console-api.js'

export const api = {
  bootstrap: () => request<ConsoleBootstrap>('/state'),

  memories: (params: {
    agentId: string
    kinds?: string[]
    emotions?: string[]
    query?: string
    trustMin?: number
    global?: boolean
    globalToken?: string
    limit?: number
  }) => {
    const search = new URLSearchParams()
    search.set('agentId', params.agentId)
    if (params.query) search.set('q', params.query)
    if (params.kinds?.length) search.set('kinds', params.kinds.join(','))
    if (params.emotions?.length) search.set('emotions', params.emotions.join(','))
    if (params.trustMin) search.set('trustMin', String(params.trustMin))
    if (params.global) search.set('global', '1')
    if (params.globalToken) search.set('globalToken', params.globalToken)
    if (params.limit) search.set('limit', String(params.limit))
    return request<MemoryCard[]>(`/memories?${search.toString()}`)
  },

  /** 修正情感标签（PRD 6 的用户纠错入口）。 */
  fixEmotion: (body: {
    versionId: string
    label: string
    subject?: string
    trigger?: string
    intensity?: number
  }) =>
    request<{ versionId: string }>('/emotion', {
      method: 'POST',
      body: JSON.stringify(body),
    }),

  /** 删除一条记忆（软删：关活跃版本 + status='forgotten'）。 */
  forgetMemory: (body: { entityId: string; agentId: string }) =>
    request<{ forgotten: boolean }>('/memory/forget', {
      method: 'POST',
      body: JSON.stringify(body),
    }),

  /** 修改一条记忆的正文（开新版本，旧版本进时间树）。 */
  editMemory: (body: { entityId: string; agentId: string; text: string }) =>
    request<{ versionId: string }>('/memory/edit', {
      method: 'POST',
      body: JSON.stringify(body),
    }),

  snapshots: (agentId: string) =>
    request<SnapshotNode[]>(`/snapshots?agentId=${encodeURIComponent(agentId)}`),

  pin: (snapshotId: string, pinned: boolean) =>
    request<{ snapshotId: string; pinned: boolean }>('/snapshots/pin', {
      method: 'POST',
      body: JSON.stringify({ snapshotId, pinned }),
    }),

  rollback: (snapshotId: string) =>
    request<{ snapshotId: string; commit: string }>('/snapshots/rollback', {
      method: 'POST',
      body: JSON.stringify({ snapshotId }),
    }),

  quarantine: (agentId: string) =>
    request<QuarantineItem[]>(`/quarantine?agentId=${encodeURIComponent(agentId)}`),

  approve: (quarantineId: string, by: string) =>
    request<{ quarantineId: string }>('/quarantine/approve', {
      method: 'POST',
      body: JSON.stringify({ quarantineId, by }),
    }),

  destroy: (quarantineId: string, by: string) =>
    request<{ quarantineId: string }>('/quarantine/destroy', {
      method: 'POST',
      body: JSON.stringify({ quarantineId, by }),
    }),

  saveNow: () =>
    request<{ snapshotId: string; commit?: string; pushed: boolean; pushReason?: string }>('/save', {
      method: 'POST',
    }),

  testConnection: () =>
    request<{ ok: boolean; remote?: string; latencyMs: number; detail: string }>('/test-connection', {
      method: 'POST',
    }),

  doctor: () => request<DoctorReportDto>('/doctor'),

  setInterval: (seconds: number) =>
    request<{ intervalSec: number }>('/sync-interval', {
      method: 'POST',
      body: JSON.stringify({ intervalSec: seconds }),
    }),

  importMemories: (body: { agentId: string; format: 'auto' | 'json' | 'markdown'; content: string }) =>
    request<{ parsed: number; written: number; quarantined: number }>('/import', {
      method: 'POST',
      body: JSON.stringify(body),
    }),

  // ── 规则与人格 ────────────────────────────────────────────────────────────
  persona: (agentId: string) =>
    request<PersonaDoc>(`/persona?agentId=${encodeURIComponent(agentId)}`),

  savePersona: (body: {
    agentId: string
    name: string
    age: number
    traits: Record<string, number>
    baselineHash?: string
  }) =>
    request<PersonaDoc>('/persona', {
      method: 'POST',
      body: JSON.stringify(body),
    }),

  rules: (agentId: string) => request<RulesBundle>(`/rules?agentId=${encodeURIComponent(agentId)}`),

  /** 申请升格：只生成待确认请求，**不会**立刻改 System Prompt。 */
  promote: (body: {
    agentId: string
    pitfallId: string
    to: RuleStage
    lesson?: string
    pattern?: string
    rule?: string
  }) =>
    request<PromotionPreview>('/rules/promote', {
      method: 'POST',
      body: JSON.stringify(body),
    }),

  confirmPromotion: (body: { agentId: string; requestId: string; by: string }) =>
    request<RuleItem>('/rules/confirm', {
      method: 'POST',
      body: JSON.stringify(body),
    }),

  rejectPromotion: (requestId: string) =>
    request<{ rejected: boolean }>('/rules/reject', {
      method: 'POST',
      body: JSON.stringify({ requestId }),
    }),

  /** 删除一条踩坑记录（物理删除，不可恢复）。 */
  deleteRule: (body: { pitfallId: string; agentId: string }) =>
    request<{ deleted: boolean }>('/rules/delete', {
      method: 'POST',
      body: JSON.stringify(body),
    }),

  // ── 会话策略 / 深度提炼 / 物理销毁 ──────────────────────────────────────
  //
  // 这三件事共用同一条"会话"主轴：ephemeral 决定要不要写，distill 决定写多少，
  // purge 决定把已经写下的彻底抹掉。所以接口放在一起，前端也只在一个地方用。

  /**
   * 读会话策略。`sessionId` 必填——策略挂在会话上而不是人格上，
   * 因为 DSH 里一个会话就是一个易变 id，换了会话必须重新问一次。
   */
  sessionPolicy: (sessionId: string, agentId?: string) => {
    const search = new URLSearchParams({ sessionId })
    if (agentId !== undefined && agentId !== '') search.set('agentId', agentId)
    return request<SessionPolicyDto>(`/session-policy?${search.toString()}`)
  },

  /** 改会话策略（无痕 / 归档模式）。只传要改的字段，未传的保持原值。 */
  saveSessionPolicy: (body: {
    sessionId: string
    ephemeral?: boolean
    archiveMode?: ArchiveMode
    agentId?: string
  }) =>
    request<SessionPolicyDto>('/session-policy', {
      method: 'POST',
      body: JSON.stringify(body),
    }),

  /** 宿主侧已知的会话列表（用于确认 sessionId 是否还有效）。 */
  sessions: () => request<{ items: ReadonlyArray<{ sessionId: string; title: string }> }>('/sessions'),

  /**
   * 当前工作区里所有"无痕会话"的 id。
   *
   * 为什么要有批量接口：侧栏每一行都要判断自己是不是无痕，
   * 逐行调 `/session-policy` 会变成 N 个请求。这里一次拿全量集合，
   * 前端只做 Set 查询；标识与策略实时联动靠轮询这个集合。
   */
  ephemeralSessions: () => request<{ ephemeral: string[] }>('/session-policies'),

  /**
   * 起一次提炼。**立即返回**任务视图（status='running'），真正的活在宿主后台跑，
   * 进度靠 `distillJob` 轮询——不要在这里 await 到结束，那会把 UI 冻住几十秒。
   */
  startDistill: (body: { sessionId: string; mode?: 'incremental' | 'deep' }) =>
    request<DistillJobDto>('/distill', {
      method: 'POST',
      body: JSON.stringify(body),
    }),

  /** 查任务进度：优先 jobId（精确），没有就退回该会话最近一次任务。 */
  distillJob: (input: { jobId?: string; sessionId?: string }) => {
    const search = new URLSearchParams()
    if (input.jobId !== undefined && input.jobId !== '') search.set('jobId', input.jobId)
    else if (input.sessionId !== undefined && input.sessionId !== '') search.set('sessionId', input.sessionId)
    return request<DistillJobDto | null>(`/distill/job?${search.toString()}`)
  },

  /**
   * 物理销毁：库表 + journal 一起清，并写 `agent.purge` 墓碑。
   * `confirm: true` 是服务端的硬闸，前端不能省——省了后端会直接 400。
   */
  purge: (agentId: string) =>
    request<{
      agentId: string
      entities: number
      versions: number
      journals: number
      records: number
      /** 顺手清掉的宿主侧会话痕迹（会话日志 + 投影缓存 + workspace 记账条目）。 */
      sessionFiles?: number
    }>('/purge', {
      method: 'POST',
      body: JSON.stringify({ agentId, confirm: true }),
    }),

  /**
   * 用户画像：按工作区存，跨 Agent 共享。
   * 它不属于某个 Agent——所以调用方不需要、也不该传 agentId。
   */
  userProfile: () => request<UserProfileDto>('/user-profile'),

  saveUserProfile: (body: { displayName?: string; preferredAddress?: string; notes?: string }) =>
    request<UserProfileDto>('/user-profile', {
      method: 'POST',
      body: JSON.stringify(body),
    }),
}

function toApiError(code: string, error: unknown): ApiError {
  return { code, message: error instanceof Error ? error.message : String(error) }
}

function safeJson(text: string): unknown {
  try {
    return JSON.parse(text) as unknown
  } catch {
    return { ok: false, error: { code: 'bad-response', message: text.slice(0, 300) } }
  }
}
