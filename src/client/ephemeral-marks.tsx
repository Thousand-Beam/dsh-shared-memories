/**
 * dsh-shared-memories — 无痕模式的持久视觉标识（client/ephemeral-marks.tsx）
 * ---------------------------------------------------------------------------
 * 问题：无痕会话只在创建时弹一次 Toast，之后聊天界面与普通会话一模一样，
 * 用户聊着聊着就忘了——而"忘了"在这里是要付代价的（以为没记，其实记了；或反过来）。
 *
 * 上一版只靠 `conversation.session.header.actions`（聊天头部徽标）与
 * `sidebar.workspaces.session.row.action`（会话行 hover 按钮）两处，
 * 真机上一条都没露头。原因很实在：
 *   ① 新建会话刚打开时是「探索未至之境」的空态，聊天头部整体不渲染 ⇒ 徽标无处可挂；
 *   ② 会话行那个 action 是 **hover 才出现** 的按钮位，不 hover 就等于不存在；
 *   ③ `<html data-dsm-ephemeral>` 只在徽标挂载时才打 ⇒ ①不成立，它也永远不会被设置。
 *
 * 所以这一版改成「一条主线 + 两处装饰」：
 *   主线：`shell.overlay`（宿主根布局里的浮层，Toast 就挂在这里，已被真机证实渲染）
 *         —— 顶部一条持续的黄褐色警告带，只要当前主视图的会话是无痕就一直在。
 *   装饰：聊天头部徽标 + 侧栏行内小幽灵（`sidebar.session.row.leading`，非 hover 位）。
 *   兜底：`<html data-dsm-ephemeral>` 改成**由数据源直接写**，不再依赖任何组件挂载，
 *         样式表据此画整窗外框，即使浮层被别的宿主版本吞了也能看见。
 *
 * 数据怎么来：
 *   · 无痕 id 集合 —— `GET /session-policies` 一次拿全量（逐行查会变 N 个请求），
 *     前端做 Set 查询；本地新建会话写完策略后立即 `mark()`，不等下一轮轮询。
 *   · "当前主视图是哪个会话" —— 从 `sessions` 客户端服务的 `list` 快照里取
 *     `retainedBy.mainView > 0` 那条（宿主 DocumentTitle 用的是同一判据）；
 *     拿不到服务时退回"最近一次由我们创建/点亮的会话"，宁可多显示也不漏显示。
 */

import { useSyncExternalStore, type ReactNode } from 'react'
import { api } from './api.js'
import type { SlotsLike } from './session-menu.js'

/** 轮询间隔：够快让人看到"关掉就消失"，又不会把接口打成筛子。 */
const POLL_MS = 2500

/** 徽标/行标的公共 props（宿主按 slot 的 scope 注入 sessionId）。 */
interface SessionSlotProps {
  sessionId?: string
  displayTitle?: string
}

/** 宿主 sessions 客户端服务的最小可用面（只为读"主视图当前会话"，不做任何写操作）。 */
interface SessionsLike {
  list?: {
    getSnapshot?: () => { byId?: Record<string, SessionRowLike> }
    subscribe?: (listener: () => void) => () => void
  }
}

interface SessionRowLike {
  retainedBy?: { mainView?: number }
  updatedAt?: number
}

/**
 * `<html data-dsm-ephemeral>`：样式表的整窗警戒钩子。
 * 用命令式同步而不是组件 `useEffect`——浮层被宿主吞掉时，这一圈橘色外框仍然在。
 */
function syncDocumentFlag(ids: ReadonlySet<string>, activeId: string | undefined): void {
  if (typeof document === 'undefined') return
  const root = document.documentElement
  if (activeId !== undefined && ids.has(activeId)) root.dataset.dsmEphemeral = '1'
  else delete root.dataset.dsmEphemeral
}

/** 无痕 id 集合：模块级单例，面板、侧栏、聊天头共用一份。 */
class EphemeralMarks {
  #ids: ReadonlySet<string> = new Set()
  #listeners = new Set<() => void>()
  #timer: ReturnType<typeof setInterval> | null = null
  #inFlight: Promise<void> | null = null
  #again = false

  subscribe = (listener: () => void): (() => void) => {
    this.#listeners.add(listener)
    this.#start()
    return () => {
      this.#listeners.delete(listener)
      if (this.#listeners.size === 0) this.#stop()
    }
  }

  /** uSES 需要稳定引用：只在内容变化时换新的 Set。 */
  getSnapshot = (): ReadonlySet<string> => this.#ids

  has(sessionId: string): boolean {
    return this.#ids.has(sessionId)
  }

  /** 本地立即生效：新建会话刚写完策略时调用，避免"要等 2.5 秒才出现徽标"。 */
  mark(sessionId: string, ephemeral: boolean): void {
    if (sessionId === '') return
    const next = new Set(this.#ids)
    if (ephemeral) next.add(sessionId)
    else next.delete(sessionId)
    this.#publish(next)
  }

  /** 拉一次全量集合；并发调用合并成一次请求，飞行中再来的请求排队补一次。 */
  refresh = async (): Promise<void> => {
    if (this.#inFlight !== null) {
      // 飞行中的那一次可能是在"切会话之前"发出的，结果对现在已过期：
      // 不并发打两个请求，但记一笔，等它回来再补一次，别让标识停在旧值上。
      this.#again = true
      return this.#inFlight
    }
    this.#inFlight = (async () => {
      try {
        const data = await api.ephemeralSessions()
        this.#publish(new Set(data.ephemeral))
      } catch {
        // 拉取失败保留上一次的集合：标识短暂滞后好过闪一下消失让人误判。
      } finally {
        this.#inFlight = null
        if (this.#again) {
          this.#again = false
          void this.refresh()
        }
      }
    })()
    return this.#inFlight
  }

  #publish(next: ReadonlySet<string>): void {
    if (sameSet(this.#ids, next)) return
    this.#ids = next
    syncDocumentFlag(this.#ids, actives.getSnapshot())
    for (const listener of this.#listeners) listener()
  }

  #start(): void {
    if (this.#timer !== null) return
    void this.refresh()
    this.#timer = setInterval(() => void this.refresh(), POLL_MS)
  }

  #stop(): void {
    if (this.#timer === null) return
    clearInterval(this.#timer)
    this.#timer = null
  }
}

/**
 * "主视图当前是哪个会话"。宿主的 `sessions.list` 快照里有 `retainedBy.mainView`，
 * 计数 > 0 就是被主面板占着的那条——和宿主自己算 document.title 的判据一致。
 */
class ActiveSession {
  #id: string | undefined
  #listeners = new Set<() => void>()

  subscribe = (listener: () => void): (() => void) => {
    this.#listeners.add(listener)
    return () => {
      this.#listeners.delete(listener)
    }
  }

  getSnapshot = (): string | undefined => this.#id

  set(sessionId: string | undefined): void {
    if (sessionId === this.#id) return
    this.#id = sessionId === '' ? undefined : sessionId
    syncDocumentFlag(marks.getSnapshot(), this.#id)
    for (const listener of this.#listeners) listener()
  }
}

function sameSet(a: ReadonlySet<string>, b: ReadonlySet<string>): boolean {
  if (a === b) return true
  if (a.size !== b.size) return false
  for (const id of a) if (!b.has(id)) return false
  return true
}

const marks = new EphemeralMarks()
const actives = new ActiveSession()

function pickMain(state: { byId?: Record<string, SessionRowLike> } | undefined): string | undefined {
  const byId = state?.byId
  if (byId === undefined) return undefined
  let best: string | undefined
  let bestAt = Number.NEGATIVE_INFINITY
  for (const [id, row] of Object.entries(byId)) {
    if ((row?.retainedBy?.mainView ?? 0) <= 0) continue
    const at = typeof row?.updatedAt === 'number' ? row.updatedAt : 0
    if (at >= bestAt) {
      best = id
      bestAt = at
    }
  }
  return best
}

/**
 * 接上宿主 `sessions` 服务，跟踪"主视图当前会话"。
 * 拿不到就安静退化成"只认本地新建的那个"——少一点准确度，不阻断任何东西。
 */
export function attachSessions(sessions: SessionsLike | undefined): () => void {
  const list = sessions?.list
  if (typeof list?.getSnapshot !== 'function' || typeof list.subscribe !== 'function') {
    console.warn('[shared-memories] 取不到 sessions.list：无痕标识退化为"按最近创建会话"判断')
    return () => undefined
  }
  const sync = (): void => {
    const next = pickMain(list.getSnapshot?.())
    // 取不到主视图（例如用户停在首页面板）时保留上一个值：宁可多显示警示，不可漏显示。
    if (next === undefined) return
    const changed = next !== actives.getSnapshot()
    actives.set(next)
    // 刚切到一个本地还不知道状态的会话：立刻补一次集合查询，
    // 不然最长要等满一个轮询周期，用户会以为"无痕标识没生效"。
    if (changed && !marks.has(next)) void marks.refresh()
  }
  try {
    const off = list.subscribe(sync)
    sync()
    return off
  } catch (error) {
    console.warn('[shared-memories] 订阅 sessions.list 失败：', error)
    return () => undefined
  }
}

/** 外部（新建会话拦截器）用它做"写完策略立刻点亮"。 */
export function markEphemeral(sessionId: string, ephemeral: boolean): void {
  marks.mark(sessionId, ephemeral)
  // 新建后主视图必切到这条会话：立刻认它，别等 sessions.list 下一帧。
  actives.set(sessionId)
}

/** 主动拉一次全量（供外部/测试在写完策略后立刻对齐）。 */
export function refreshEphemeralMarks(): Promise<void> {
  return marks.refresh()
}

/** 当前会话是否无痕（调试/测试用）。 */
export function activeEphemeral(): boolean {
  const id = actives.getSnapshot()
  return id !== undefined && marks.has(id)
}

function useIsEphemeral(sessionId: string | undefined): boolean {
  const ids = useSyncExternalStore(marks.subscribe, marks.getSnapshot, marks.getSnapshot)
  return sessionId !== undefined && sessionId !== '' && ids.has(sessionId)
}

function useActiveEphemeral(): boolean {
  const ids = useSyncExternalStore(marks.subscribe, marks.getSnapshot, marks.getSnapshot)
  const active = useSyncExternalStore(actives.subscribe, actives.getSnapshot, actives.getSnapshot)
  return active !== undefined && ids.has(active)
}

/**
 * 主线：顶部持续警告带，挂在 `shell.overlay`（根布局浮层，Toast 同源）。
 * 不依赖聊天头部是否渲染，空白会话/长对话/切面板都在。
 */
export function EphemeralBanner(): ReactNode {
  const active = useActiveEphemeral()
  if (!active) return null
  return (
    <div className='dsm-ghost-banner' role='status' aria-live='polite'>
      <span className='dsm-ghost-banner-icon' aria-hidden='true'>
        👻
      </span>
      <span className='dsm-ghost-banner-text'>
        无痕会话 —— 记忆只读，不写入、不进快照、不留人格
      </span>
    </div>
  )
}

/** 装饰 ①：聊天头部徽标（有头部时才有；没有也不影响主线）。 */
export function EphemeralBadge({ sessionId }: SessionSlotProps): ReactNode {
  const active = useIsEphemeral(sessionId)
  if (!active) return null
  return (
    <span
      className='dsm-ghost-badge'
      title='无痕会话：记忆只读，不写库、不进快照、不留人格。关掉这个会话即结束无痕状态。'
    >
      <span className='dsm-ghost-badge-dot' aria-hidden='true'>
        👻
      </span>
      无痕模式
    </span>
  )
}

/** 装饰 ②③：侧栏行内小幽灵（行首常驻位 + 行尾 hover 位各挂一个，谁在就谁显示）。 */
export function EphemeralRowMark({ sessionId }: SessionSlotProps): ReactNode {
  const active = useIsEphemeral(sessionId)
  if (!active) return null
  return (
    <span className='dsm-ghost-row' title='无痕会话：不写记忆、不进快照、不留人格' aria-label='无痕会话'>
      👻
    </span>
  )
}

/** 槽位注册的小兜底：某一版宿主没这个槽，就只少这一处标识。 */
function safeMount(
  slots: SlotsLike,
  slotName: string,
  entry: Record<string, unknown>,
  component: (props: SessionSlotProps) => ReactNode,
): () => void {
  try {
    return slots.inject(slotName, () => {
      try {
        return slots.register(entry, component as never)
      } catch (error) {
        console.error('[shared-memories] 无痕标识注册失败（已跳过）：', slotName, error)
        return () => undefined
      }
    })
  } catch (error) {
    console.error('[shared-memories] 无痕标识挂载失败（已跳过）：', slotName, error)
    return () => undefined
  }
}

/** 装配主线 + 装饰；返回卸载函数。 */
export function mountEphemeralMarks(slots: SlotsLike): () => void {
  // 预热：不等 React 订阅就先拉一次，首帧就能判断当前会话是不是无痕
  // （也顺手让 `<html>` 上的整窗标记与首屏同步，不会先白一帧再变橘）。
  void marks.refresh()
  const disposers = [
    safeMount(
      slots,
      'shell.overlay',
      { name: 'shell.overlay', id: 'shared-memories-ephemeral-banner', order: 5 },
      EphemeralBanner as unknown as (props: SessionSlotProps) => ReactNode,
    ),
    safeMount(
      slots,
      'conversation.session.header.actions',
      { name: 'conversation.session.header.actions', id: 'shared-memories-ephemeral-badge', order: 5 },
      EphemeralBadge,
    ),
    safeMount(
      slots,
      'sidebar.session.row.leading',
      { name: 'sidebar.session.row.leading', id: 'shared-memories-ephemeral-leading', order: 5 },
      EphemeralRowMark,
    ),
    safeMount(
      slots,
      'sidebar.workspaces.session.row.action',
      { name: 'sidebar.workspaces.session.row.action', id: 'shared-memories-ephemeral-row', order: 200 },
      EphemeralRowMark,
    ),
  ]
  return () => {
    for (const dispose of disposers) dispose()
  }
}
