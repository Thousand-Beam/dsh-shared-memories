/**
 * dsh-shared-memories — 会话入口与记忆菜单（client/session-menu.tsx）
 * ---------------------------------------------------------------------------
 * 这个文件解决三个"用户真的会点"的入口：
 *
 *   ① 新建会话时的二选一（正常 / 无痕）
 *      —— 拦截 `uiWorkspace.createNamed`（新建会话的唯一漏斗），先弹窗，
 *         选完再把 `session_policy` 写进服务端，最后才把 sessionId 交回宿主。
 *         顺序很重要：**先有策略、后有会话**，第一条消息就不可能有漏网机会。
 *
 *   ② 会话行「⋯」菜单里的三项
 *      —— 官方槽位 `sidebar.workspaces.session.menu.item`（ui-workspace 声明，
 *         subagent 插件也在用），注册进去就是原生菜单行，不需要自己造悬浮菜单。
 *           · 归档并深度记忆：deep 提炼 →（成功再）归档
 *           · 归档但不记忆：策略直接锁成 ephemeral + off → 归档
 *           · 彻底销毁会话：一键 purge（库表 + journal + 墓碑 + 宿主会话日志）→ 归档
 *
 *   ③ 全局浮层：新建会话选择框、提炼进度、Toast
 *      —— 都挂 `shell.overlay`。注意它们**在面板之外**渲染，拿不到
 *         `ConsoleContext`，所以 store 是通过 slot 的 `inject` 直接塞成 props 的。
 *
 * 三条交互红线：
 *   · 无痕的判定必须发生在**写入之前**（服务端 DistillService.writable 与快照闸门），
 *     前端只负责"把选择尽早递过去"；
 *   · 销毁是**一次点击**（用户明确要求去掉勾选+手打短语的仪式），但顺序不能乱：
 *     锁无痕 → 归档停写 → purge（含删宿主会话日志）→ 刷新；
 *   · 提炼是轮询不是等待，切会话要能中途放弃（runDistillJob 的 signal）。
 */

import {
  useSyncExternalStore,
  useState,
  type ComponentType,
  type ReactNode,
} from 'react'
import { api } from './api.js'
import type { ConsoleStore } from './state.js'
import { progressText, runDistillJob } from './session-tools.js'
import { Modal } from './ui.js'

/* ── 宿主 slots 的最小面 ──────────────────────────────────────────────── */

export interface SlotsLike {
  inject(slotName: string, register: () => () => void): () => void
  register(
    options: Record<string, unknown>,
    component: ComponentType<never> | ((props: never) => unknown),
  ): () => void
}

/* ── 新建会话：二选一 ─────────────────────────────────────────────────── */

export interface SessionModeChoice {
  ephemeral: boolean
}

interface AskSessionMode {
  workspaceId: string
  resolve: (choice: SessionModeChoice | null) => void
}

let pendingAsk: AskSessionMode | null = null
const askListeners = new Set<() => void>()

function emitAsk(): void {
  for (const listener of askListeners) listener()
}

/**
 * 询问这一次新建会话要用哪种模式。
 *
 * 返回 `null` 表示用户取消——调用方（被包裹的 createNamed）应当**不创建会话**，
 * 而不是偷偷按"正常"建一个。
 */
export function askSessionMode(workspaceId: string): Promise<SessionModeChoice | null> {
  // 同一时刻只允许一个选择框：连点两下"新会话"时，旧的那次按取消处理。
  pendingAsk?.resolve(null)
  return new Promise<SessionModeChoice | null>((resolve) => {
    pendingAsk = { workspaceId, resolve }
    emitAsk()
  })
}

function settleAsk(choice: SessionModeChoice | null): void {
  const current = pendingAsk
  pendingAsk = null
  emitAsk()
  current?.resolve(choice)
}

function subscribeAsk(listener: () => void): () => void {
  askListeners.add(listener)
  return () => {
    askListeners.delete(listener)
  }
}

function useAsk(): AskSessionMode | null {
  return useSyncExternalStore(
    subscribeAsk,
    () => pendingAsk,
    () => null,
  )
}

/** 新建会话选择框（`shell.overlay`）。 */
export function NewSessionDialog(): ReactNode {
  const ask = useAsk()
  // 关掉对话框时 NewSessionDialog 返回 null，表单随之卸载、busy 自动复位，
  // 所以这里不需要再拿 key 去"强制重挂"。
  if (ask === null) return null
  return <NewSessionForm />
}

function NewSessionForm(): ReactNode {
  const [busy, setBusy] = useState(false)

  const pick = (ephemeral: boolean): void => {
    if (busy) return
    setBusy(true)
    settleAsk({ ephemeral })
  }

  return (
    <Modal
      title='这条会话要怎么记住？'
      onClose={() => settleAsk(null)}
      actions={
        <button type='button' className='dsm-btn dsm-btn--sm dsm-btn--ghost' onClick={() => settleAsk(null)}>
          取消
        </button>
      }
    >
      <div className='dsm-caption' style={{ marginBottom: 12 }}>
        选择会在会话创建的同时写入会话策略，第一条消息就按它执行。
      </div>
      <div className='dsm-choice'>
        <button
          type='button'
          className='dsm-choice-card'
          disabled={busy}
          onClick={() => pick(false)}
          title='记忆可读写：对话会被提炼进记忆，也会进入快照'
        >
          <span className='dsm-choice-icon' aria-hidden='true'>
            ✦
          </span>
          <span className='dsm-choice-title'>正常会话</span>
          <span className='dsm-choice-body'>
            记忆<b>可读可写</b>。对话会被提炼成记忆条目，随快照同步到其他设备。
          </span>
          <span className='dsm-choice-foot'>推荐 · 会积累人格与长期记忆</span>
        </button>

        <button
          type='button'
          className='dsm-choice-card dsm-choice-card--ghost'
          disabled={busy}
          onClick={() => pick(true)}
          title='无痕：记忆可读，但本会话不写入任何记忆、不进快照、不留人格'
        >
          <span className='dsm-choice-icon' aria-hidden='true'>
            👻
          </span>
          <span className='dsm-choice-title'>无痕会话</span>
          <span className='dsm-choice-body'>
            记忆<b>只读</b>。能读到已有记忆，但本会话<b>不写记忆、不进快照、不留人格</b>。
          </span>
          <span className='dsm-choice-foot'>适合一次性提问、涉密内容</span>
        </button>
      </div>
    </Modal>
  )
}

/* ── Toast ────────────────────────────────────────────────────────────── */

export interface ToastItem {
  id: number
  tone: 'ok' | 'error'
  text: string
}

let toasts: ToastItem[] = []
let toastSeq = 0
const toastListeners = new Set<() => void>()

function emitToasts(): void {
  for (const listener of toastListeners) listener()
}

/** 全局提示：菜单动作不在面板里，不能借用面板的 toast 状态。 */
export function pushToast(tone: 'ok' | 'error', text: string): void {
  const id = ++toastSeq
  toasts = [...toasts, { id, tone, text }]
  emitToasts()
  window.setTimeout(() => {
    toasts = toasts.filter((item) => item.id !== id)
    emitToasts()
  }, 5200)
}

function subscribeToasts(listener: () => void): () => void {
  toastListeners.add(listener)
  return () => {
    toastListeners.delete(listener)
  }
}

function useToasts(): ToastItem[] {
  return useSyncExternalStore(
    subscribeToasts,
    () => toasts,
    () => [],
  )
}

/** 右下角 Toast 堆（`shell.overlay`）。 */
export function GlobalToaster(): ReactNode {
  const items = useToasts()
  if (items.length === 0) return null
  return (
    <div className='dsm-toast-stack' role='status' aria-live='polite'>
      {items.map((item) => (
        <div key={item.id} className='dsm-toast' data-tone={item.tone}>
          <span className='dsm-toast-dot' aria-hidden='true' />
          <span>{item.text}</span>
        </div>
      ))}
    </div>
  )
}

/* ── 归档兜底 ─────────────────────────────────────────────────────────── */

/**
 * 槽位 `inject` 并不总是能被浮层拿到（有的宿主版本只把 inject 合进菜单行），
 * 于是 `props.archiveSession` 在销毁确认框里是 undefined —— 空链一接，
 * 销毁照样"成功"、Toast 照样弹，侧栏那一行却没人归档：
 * 用户看到的就是一个点不开的空壳。所以这里在装配时再存一份模块级兜底。
 */
let archiverFallback: ((sessionId: string) => Promise<void>) | null = null
let resyncFallback: ((sessionId: string) => Promise<void>) | null = null

function archiverOf(primary?: (sessionId: string) => Promise<void>): ((sessionId: string) => Promise<void>) | null {
  if (typeof primary === 'function') return primary
  return archiverFallback
}

/**
 * 尽力归档：返回 null 表示已经归档成功，返回字符串表示失败原因。
 *
 * 重试两次、间隔递增的理由：purge 刚把宿主的记忆/persona 行删干净，
 * 宿主的会话侧栏可能正在重算投影，此刻归档偶尔会撞上"会话刚被关掉"的中间态。
 */
async function archiveSessionHard(
  sessionId: string,
  primary?: (sessionId: string) => Promise<void>,
): Promise<string | null> {
  const archiver = archiverOf(primary)
  if (archiver === null) return '宿主没有提供会话归档能力'
  let reason = '未知错误'
  for (const wait of [0, 150, 400]) {
    if (wait > 0) {
      await new Promise<void>((resolve) => {
        window.setTimeout(resolve, wait)
      })
    }
    try {
      await archiver(sessionId)
      return null
    } catch (cause) {
      reason = messageOf(cause)
    }
  }
  return reason
}

/* ── 菜单项 ───────────────────────────────────────────────────────────── */

interface MenuProps {
  sessionId: string
  displayTitle?: string
  /** 宿主给菜单行注入的关闭钩子（槽位 children.inject 提供）。 */
  useMenuOpenState?: () => [boolean, (next: boolean) => void]
  /** 下面几项由本插件的 `inject` 塞进来。 */
  store?: ConsoleStore
  archiveSession?: (sessionId: string) => Promise<void>
}

/** 没有宿主钩子时的替身：保证 hooks 调用顺序恒定。 */
function useNoMenuState(): [boolean, (next: boolean) => void] {
  return useState(false)
}

function closeOf(props: MenuProps): () => void {
  const useMenu = props.useMenuOpenState ?? useNoMenuState
  const [, setOpen] = useMenu()
  return () => setOpen(false)
}

/** 同 client/index.ts：HTTP 层抛的是 `{code,message}` 普通对象，别让 UI 显示 [object Object]。 */
function messageOf(cause: unknown): string {
  if (cause instanceof Error) return cause.message
  if (cause !== null && typeof cause === 'object') {
    const record = cause as { message?: unknown; code?: unknown }
    if (typeof record.message === 'string' && record.message !== '') return record.message
    if (typeof record.code === 'string' && record.code !== '') return record.code
  }
  const text = String(cause)
  return text === '[object Object]' ? '未知错误' : text
}

function MenuRow(props: {
  label: string
  hint: string
  icon: string
  danger?: boolean
  busy?: boolean
  onSelect: () => void
}): ReactNode {
  return (
    <button
      type='button'
      // role 对齐宿主菜单：`Menu` 靠 menuitem 做方向键在选项间移动。
      role='menuitem'
      className={props.danger === true ? 'dsm-menu-row dsm-menu-row--danger' : 'dsm-menu-row'}
      disabled={props.busy === true}
      title={props.hint}
      onClick={props.onSelect}
    >
      <span className='dsm-menu-icon' aria-hidden='true'>
        {props.icon}
      </span>
      <span className='dsm-menu-text'>
        <span className='dsm-menu-label'>{props.label}</span>
        <span className='dsm-menu-hint'>{props.hint}</span>
      </span>
    </button>
  )
}

/** 归档并深度记忆：先 deep 提炼，成功才归档（失败不动会话，避免"以为记住了"）。 */
function ArchiveDeepMenuItem(props: MenuProps): ReactNode {
  const close = closeOf(props)
  const [busy, setBusy] = useState(false)

  const run = async (): Promise<void> => {
    close()
    if (busy) return
    setBusy(true)
    const store = props.store
    try {
      if (store === undefined) throw new Error('控制台未就绪')
      pushToast('ok', '开始深度重读整段对话…')
      const outcome = await runDistillJob(store, props.sessionId, 'deep')
      if (outcome.status === 'failed' || outcome.status === 'timeout') {
        pushToast('error', `${outcome.error === '' ? '提炼失败' : outcome.error}；会话未归档，可重试`)
        return
      }
      if (props.archiveSession === undefined) throw new Error('宿主未提供会话服务')
      // 深度提炼已经跑完：把策略锁成 off，否则归档触发的 session-stop
      // 会再跑一次 incremental —— 同一段对话提炼两遍，纯烧 token。
      await api
        .saveSessionPolicy({ sessionId: props.sessionId, agentId: props.sessionId, archiveMode: 'off' })
        .catch(() => undefined)
      await props.archiveSession(props.sessionId)
      if (outcome.status === 'done') {
        pushToast('ok', `已归档并固化 ${outcome.written} 条记忆`)
      } else {
        pushToast('ok', `已归档（${outcome.detail === '' ? '按策略跳过提炼' : outcome.detail}）`)
      }
    } catch (cause) {
      pushToast('error', messageOf(cause))
    } finally {
      setBusy(false)
    }
  }

  return (
    <MenuRow
      icon='🧠'
      label='归档并深度记忆'
      hint='结束会话，并把整段对话重读一遍写进长期记忆'
      busy={busy}
      onSelect={() => void run()}
    />
  )
}

/** 归档但不记忆：策略先锁成 ephemeral + off，再归档——顺序不能反。 */
function ArchivePlainMenuItem(props: MenuProps): ReactNode {
  const close = closeOf(props)
  const [busy, setBusy] = useState(false)

  const run = async (): Promise<void> => {
    close()
    if (busy) return
    setBusy(true)
    try {
      // 先落策略：即使归档过程中宿主触发 session-stop，也会因为 off 直接短路。
      await api.saveSessionPolicy({
        sessionId: props.sessionId,
        agentId: props.sessionId,
        ephemeral: true,
        archiveMode: 'off',
      })
      if (props.archiveSession === undefined) throw new Error('宿主未提供会话服务')
      await props.archiveSession(props.sessionId)
      props.store?.setDistill(null)
      pushToast('ok', '已归档：这条会话没有写入任何记忆，也不会进快照')
    } catch (cause) {
      pushToast('error', messageOf(cause))
    } finally {
      setBusy(false)
    }
  }

  return (
    <MenuRow
      icon='📥'
      label='归档但不记忆'
      hint='只保留对话历史，绝不写入记忆与快照'
      busy={busy}
      onSelect={() => void run()}
    />
  )
}

/**
 * 一键销毁：点一下就跑完，不再弹确认框。
 *
 * 用户原话：「点击删除删除就好了，没必要这么繁琐」——勾选框 + 输入「彻底销毁」
 * 那一套去掉了。顺序仍然讲究，不能随便调：
 *
 *   ① 锁成"永不记忆"（ephemeral + off）——不先锁，删完之后用户再敲一句，
 *      记忆会被重新写回库，下一次冷启动归并又把它们复活；
 *   ② 归档（stopActivity）——先让宿主停掉这条会话的写入，后面删日志才删得动，
 *      而且侧栏不会再触发它的投影；
 *   ③ purge——删库 + 改写 journal + 墓碑 + 删宿主会话日志（`~/.dsh/sessions/…`），
 *      这一步不做，侧栏就留一个点不开的空壳；
 *   ④ 刷 store / bootstrap / 投影重算，最后一条 Toast 收尾。
 */
async function purgeSessionHard(props: MenuProps): Promise<void> {
  const sessionId = props.sessionId
  const store = props.store
  try {
    await api
      .saveSessionPolicy({ sessionId, agentId: sessionId, ephemeral: true, archiveMode: 'off' })
      .catch(() => undefined)

    // 归档失败不致命（宿主可能已经把会话关掉了），但要把原因留着告诉用户。
    const archiveError = await archiveSessionHard(sessionId, props.archiveSession)

    const result = await api.purge(sessionId)

    store?.patch({ memories: [], snapshots: [], quarantine: [], policy: null, distill: null })
    try {
      const boot = await api.bootstrap()
      store?.patch({ agents: boot.agents, activeAgentId: boot.activeAgentId })
    } catch {
      // 刷新失败不影响"已销毁"这个事实，列表保持原样即可。
    }
    await (resyncFallback?.(sessionId) ?? Promise.resolve()).catch(() => undefined)

    const head = `已销毁 ${result.entities} 条记忆、${result.versions} 个版本、${result.journals} 份会话日志`
    const fileCount = result.sessionFiles ?? 0
    const logs = fileCount > 0 ? `、${fileCount} 份会话痕迹` : ''
    if (archiveError === null) {
      pushToast('ok', `${head}${logs}；侧栏那一行已删除`)
    } else {
      pushToast(
        'error',
        `${head}${logs}；但侧栏会话没能归档（${archiveError}）：请右键该会话手动「归档」一次`,
      )
    }
  } catch (cause) {
    pushToast('error', messageOf(cause))
  }
}

/** 菜单行：点击即销毁（busy 期间禁用，防连点删两遍）。 */
function PurgeMenuItem(props: MenuProps): ReactNode {
  const close = closeOf(props)
  const [busy, setBusy] = useState(false)

  return (
    <MenuRow
      icon='🗑'
      label='彻底销毁会话'
      hint='不可撤销：删记忆、人格、会话日志与对话记录'
      danger
      busy={busy}
      onSelect={() => {
        close()
        void (async () => {
          setBusy(true)
          try {
            await purgeSessionHard(props)
          } finally {
            setBusy(false)
          }
        })()
      }}
    />
  )
}

/* ── 全局提炼进度 ─────────────────────────────────────────────────────── */

function DistillOverlay(props: { store?: ConsoleStore }): ReactNode {
  const store = props.store
  const progress = useSyncExternalStore(
    store?.subscribe ?? (() => () => undefined),
    () => store?.getState().distill ?? null,
    () => null,
  )
  if (store === undefined || progress === null) return null
  const percent =
    progress.total <= 0 ? 0 : Math.min(100, Math.round((progress.chunk / progress.total) * 100))
  return (
    <div className='dsm-float-card' role='status' aria-live='polite'>
      <div className='dsm-float-title'>
        深度重读{progress.status === 'running' ? '进行中' : '结束'}
      </div>
      <div className='dsm-progress' data-tone={progress.status}>
        <i style={{ width: `${progress.status === 'running' ? Math.max(6, percent) : 100}%` }} />
      </div>
      <div className='dsm-caption'>
        {progressText(progress.status, progress.phase, progress.chunk, progress.total, progress.written)}
      </div>
      {progress.status === 'running' ? null : (
        <button type='button' className='dsm-btn dsm-btn--sm dsm-btn--ghost' onClick={() => store.setDistill(null)}>
          收起
        </button>
      )}
    </div>
  )
}

/* ── 装配 ─────────────────────────────────────────────────────────────── */

export interface SessionMenuOptions {
  slots: SlotsLike
  store: ConsoleStore
  /** 归档会话（宿主 uiWorkspace 的能力，由 index.ts 注入）。 */
  archiveSession: (sessionId: string) => Promise<void>
  /** 销毁后让宿主重算该会话的投影（侧栏重绘）。可选：拿不到就只做归档。 */
  resyncSessions?: (sessionId: string) => Promise<void>
}

/**
 * 把菜单行 + 四个浮层挂到宿主槽位上。
 *
 * 全部包在 `slots.inject(...)` 里：槽位是**别人**声明的，早于它注册等于挂给空气。
 *
 * @returns 卸载函数（插件 dispose 时统一调用）。
 */
export function mountSessionMemoryUi(options: SessionMenuOptions): () => void {
  const { slots, store, archiveSession } = options
  // 浮层拿不到 inject 时的兜底（见 archiverOf 的注释）。
  archiverFallback = archiveSession
  resyncFallback = typeof options.resyncSessions === 'function' ? options.resyncSessions : null
  const menuInjected = (): Record<string, unknown> => ({ store, archiveSession })
  const disposers: Array<() => void> = []

  /**
   * 单条注册的兜底：某个槽位在我们这版宿主里不存在 / 选项不被接受时，
   * 只丢这一项（菜单少一行），绝不让 apply 抛出去把 fiber 打挂。
   */
  const register = (
    entry: Record<string, unknown>,
    component: ComponentType<never>,
  ): (() => void) => {
    try {
      return slots.register(entry, component)
    } catch (error) {
      console.error('[shared-memories] slot 注册失败（已跳过）：', entry.name, entry.id ?? entry.key ?? '', error)
      return () => undefined
    }
  }

  /** 整个槽位注入的兜底：连 slots.inject 本身失败也只降级，不抛出。 */
  const guard = (label: string, run: () => () => void): (() => void) => {
    try {
      return run()
    } catch (error) {
      console.error(`[shared-memories] ${label} 挂载失败（已跳过）：`, error)
      return () => undefined
    }
  }

  disposers.push(
    guard('会话菜单', () =>
      slots.inject('sidebar.workspaces.session.menu.item', () => {
        const offs = [
          register(
            { name: 'sidebar.workspaces.session.menu.item', id: 'shared-memories-archive-deep', order: 600, inject: menuInjected },
            ArchiveDeepMenuItem as unknown as ComponentType<never>,
          ),
          register(
            { name: 'sidebar.workspaces.session.menu.item', id: 'shared-memories-archive-plain', order: 610, inject: menuInjected },
            ArchivePlainMenuItem as unknown as ComponentType<never>,
          ),
          register(
            { name: 'sidebar.workspaces.session.menu.item', id: 'shared-memories-purge', order: 690, inject: menuInjected },
            PurgeMenuItem as unknown as ComponentType<never>,
          ),
        ]
        return () => {
          for (const off of offs) off()
        }
      }),
    ),
  )

  disposers.push(
    guard('全局浮层', () =>
      slots.inject('shell.overlay', () => {
        const offs = [
          register(
            { name: 'shell.overlay', id: 'shared-memories-new-session', order: 10 },
            NewSessionDialog as unknown as ComponentType<never>,
          ),
          register(
            { name: 'shell.overlay', id: 'shared-memories-distill-progress', order: 30, inject: () => ({ store }) },
            DistillOverlay as unknown as ComponentType<never>,
          ),
          register(
            { name: 'shell.overlay', id: 'shared-memories-toasts', order: 40 },
            GlobalToaster as unknown as ComponentType<never>,
          ),
        ]
        return () => {
          for (const off of offs) off()
        }
      }),
    ),
  )

  return () => {
    archiverFallback = null
    resyncFallback = null
    for (const dispose of disposers) dispose()
  }
}
