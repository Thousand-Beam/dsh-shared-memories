/**
 * dsh-shared-memories — 控制台 API 客户端（client/api.ts）
 * ---------------------------------------------------------------------------
 * 所有请求都走宿主插件注册的 HTTP 路由（前缀 `/dsh/shared-memories`）。
 * 统一在这里做三件事：拼 URL、解包 `{ok,data,error}`、把网络异常转成可展示文案。
 *
 * 注意：不在这里存 token、不读 localStorage。令牌只存在于当前页面内存，
 * 由 `ConsoleStore` 持有——这是"全局检索必须显式授权"的一部分。
 */

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
    throw payload.error ?? { code: `http-${response.status}`, message: text.slice(0, 300) }
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

  saveNow: () => request<{ snapshotId: string; commit?: string }>('/save', { method: 'POST' }),

  testConnection: () =>
    request<{ ok: boolean; remote?: string; latencyMs: number; detail: string }>('/test-connection', {
      method: 'POST',
    }),

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
