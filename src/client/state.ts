/**
 * dsh-shared-memories — 控制台状态管理（client/state.ts）
 * ---------------------------------------------------------------------------
 * 方案说明（为什么不用 Redux / zustand）：
 *
 * 控制台的读多写少，且只有"当前 agent / 当前视图 / 过滤器 / 数据快照"这几个维度。
 * 引入第三方 store 只会让插件多背一个 peer 依赖，还会把 React 版本锁死。
 * 这里用**手写极简 store + useSyncExternalStore**：
 *   - 单一 `ConsoleState` 不可变对象，任何更新都是整体替换（不会出现半更新状态）；
 *   - 订阅粒度是"整个 state"，配合选择器函数，够用且没有心智负担；
 *   - store 里不放 Promise：异步请求一律走 `api.ts`，回来再 `patch()`。
 *
 * 多智能体在这里的体现：`activeAgentId` 是 UI 的一等公民。切换它会同时
 * 触发 `onAgentChange` 回调（由 index.ts 上游刷新记忆/快照/人格三份数据）。
 */

import { createContext, useContext, useSyncExternalStore } from 'react'

export type ViewKey = 'overview' | 'memory' | 'snapshots' | 'rules' | 'quarantine'

/**
 * 数据形状一律从 `src/shared/console-api.ts` 来：host 的 HTTP 层与这里的 store
 * 共用同一份 DTO，改字段时 `tsc` 会同时点出两端，不靠人肉同步。
 */
export type {
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
} from '../shared/console-api.js'

import type {
  AgentSummary,
  MemoryCard,
  QuarantineItem,
  RestorePhase,
  SnapshotNode,
} from '../shared/console-api.js'
import type { DistillJobDto, SessionPolicyDto } from '../shared/session-policy.js'

/**
 * 提炼进度在 UI 侧的形状：只留渲染要用的字段。
 * 单独抽出来是因为 `DistillJobDto` 里还有 report / 时间戳等一大坨，
 * 塞进 store 会让每次 `patch` 都复制一堆前端根本读不到的字段。
 */
export interface DistillProgress {
  readonly jobId: string
  readonly status: 'running' | 'done' | 'failed' | 'skipped'
  readonly phase: string
  readonly detail: string
  readonly chunk: number
  readonly total: number
  readonly written: number
}

export function progressOf(job: DistillJobDto): DistillProgress {
  return {
    jobId: job.jobId,
    status: job.status,
    phase: job.phase,
    detail: job.detail,
    chunk: job.chunk,
    total: job.total,
    written: job.written,
  }
}

export interface MemoryFilters {
  query: string
  kinds: string[]
  emotions: string[]
  trustMin: number
  /** 跨智能体 / 跨工作区检索（需要全局令牌）。 */
  global: boolean
}

export interface ConsoleState {
  /** 数据加载状态；`degraded` 时顶部挂黄条。 */
  status: 'idle' | 'loading' | 'ready' | 'degraded'
  phase: RestorePhase
  phaseDetail: string
  view: ViewKey
  agents: AgentSummary[]
  activeAgentId: string
  memories: MemoryCard[]
  snapshots: SnapshotNode[]
  quarantine: QuarantineItem[]
  /** 快照池轮转保留数量（来自 bootstrap，用于文案而非自算）。 */
  snapshotKeep: number
  /** 是否允许跨 Agent 检索（宿主开关，关掉时前端不该给入口）。 */
  allowGlobalSearch: boolean
  /** 当前工作区标识（侧栏底部展示，便于确认"我在哪个工作区里看记忆"）。 */
  workspaceId: string
  /** 当前设备标识（与工作区配对，说明快照是从哪台机器落盘的）。 */
  deviceId: string
  filters: MemoryFilters
  /**
   * 当前会话的策略（无痕 / 归档模式）。`null` = 还没读回来。
   *
   * 它必须跟着 `activeAgentId` 走：策略挂会话，切人会换一份，
   * 不跟着换就会出现"A 会话无痕开着，UI 却显示 B 会话正常"的错位。
   */
  policy: SessionPolicyDto | null
  /** 正在跑的提炼任务；`null` = 没有任务在跑。 */
  distill: DistillProgress | null
  toast: { kind: 'ok' | 'warn' | 'error'; message: string } | null
  error: string | null
}

export const INITIAL_STATE: ConsoleState = {
  status: 'idle',
  phase: 'cold',
  phaseDetail: '',
  view: 'memory',
  agents: [],
  activeAgentId: '',
  memories: [],
  snapshots: [],
  quarantine: [],
  snapshotKeep: 5,
  allowGlobalSearch: false,
  workspaceId: '',
  deviceId: '',
  filters: { query: '', kinds: [], emotions: [], trustMin: 0, global: false },
  policy: null,
  distill: null,
  toast: null,
  error: null,
}

export class ConsoleStore {
  #state: ConsoleState = INITIAL_STATE
  readonly #listeners = new Set<() => void>()
  #agentListener: ((agentId: string) => void) | undefined

  getState = (): ConsoleState => this.#state

  subscribe = (listener: () => void): (() => void) => {
    this.#listeners.add(listener)
    return () => {
      this.#listeners.delete(listener)
    }
  }

  /** 整体替换式更新：调用方只描述"要改哪几项"。 */
  patch(partial: Partial<ConsoleState>): void {
    this.#state = { ...this.#state, ...partial }
    for (const listener of this.#listeners) listener()
  }

  setView(view: ViewKey): void {
    this.patch({ view })
  }

  onAgentChange(listener: (agentId: string) => void): () => void {
    this.#agentListener = listener
    return () => {
      if (this.#agentListener === listener) this.#agentListener = undefined
    }
  }

  setActiveAgent(agentId: string): void {
    if (!agentId || agentId === this.#state.activeAgentId) return
    // 切 agent 必须清空旧数据：宁可闪一下骨架屏，也不要把 A 的记忆显示在 B 名下。
    // policy / distill 同理：无痕开关和提炼进度都是**会话级**的，
    // 留着上一条会话的值，等于让用户在 B 会话上看到 A 会话的无痕标记。
    this.patch({
      activeAgentId: agentId,
      memories: [],
      snapshots: [],
      quarantine: [],
      policy: null,
      distill: null,
      status: 'loading',
    })
    this.#agentListener?.(agentId)
  }

  setFilters(partial: Partial<MemoryFilters>): void {
    this.patch({ filters: { ...this.#state.filters, ...partial } })
  }

  setPolicy(policy: SessionPolicyDto | null): void {
    this.patch({ policy })
  }

  setDistill(distill: DistillProgress | null): void {
    this.patch({ distill })
  }

  toggleFilterValue(key: 'kinds' | 'emotions', value: string): void {
    const current = this.#state.filters[key]
    const next = current.includes(value) ? current.filter((item) => item !== value) : [...current, value]
    this.setFilters({ [key]: next })
  }

  toast(kind: 'ok' | 'warn' | 'error', message: string): void {
    this.patch({ toast: { kind, message } })
    setTimeout(() => {
      if (this.#state.toast?.message === message) this.patch({ toast: null })
    }, 4000)
  }
}

export const ConsoleContext = createContext<ConsoleStore | null>(null)

/** 组件里读状态：`const view = useConsole((s) => s.view)`。 */
export function useConsole<T>(selector: (state: ConsoleState) => T): T {
  const store = useContext(ConsoleContext)
  if (!store) throw new Error('ConsoleStore 未挂载：请在面板根节点包一层 <ConsoleContext.Provider>')
  return useSyncExternalStore(
    store.subscribe,
    () => selector(store.getState()),
    () => selector(INITIAL_STATE),
  )
}

export function useStore(): ConsoleStore {
  const store = useContext(ConsoleContext)
  if (!store) throw new Error('ConsoleStore 未挂载')
  return store
}

/** 记忆卡片按当前过滤器筛一遍（客户端筛选，避免每次点 chip 都打后端）。 */
export function filterMemories(state: ConsoleState): MemoryCard[] {
  const { query, kinds, emotions, trustMin } = state.filters
  const needle = query.trim().toLowerCase()
  return state.memories.filter((card) => {
    if (kinds.length > 0 && !kinds.includes(card.kind)) return false
    if (emotions.length > 0 && (!card.emotion || !emotions.includes(card.emotion.label))) return false
    if (card.trust < trustMin) return false
    if (needle && !`${card.text} ${card.subjectKey}`.toLowerCase().includes(needle)) return false
    return true
  })
}
