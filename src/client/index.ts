/**
 * dsh-shared-memories — 客户端插件入口（Web 控制台装配）
 * ---------------------------------------------------------------------------
 * 这一轮把"入口"补齐了，装配顺序也变了：**先建 store，再挂界面**。
 *
 *   ① 共享 ConsoleStore —— 面板、菜单行、全局浮层共用一份状态。
 *      菜单行与浮层挂在 `shell.overlay` / `sidebar.workspaces.session.menu.item`，
 *      它们在面板之外渲染，拿不到 `ConsoleContext`；各建一份 store 的话，
 *      "提炼进度"就只有点开面板才看得见。
 *
 *   ② 新建会话拦截 —— 两层：`uiWorkspace.startSession` 弹"正常 / 无痕"（用户意图），
 *      答��存进闭包；`uiWorkspace.createNamed` 消费它，建完立刻把 session_policy 落库。
 *      只挂 createNamed 会漏掉"复用空白会话"，只挂 startSession 会漏掉直接建会话的入口。
 *      顺序是**策略先于第一条消息**，而不是聊完了再补一个开关。
 *
 *   ③ 会话行菜单三项 —— 官方槽位 `sidebar.workspaces.session.menu.item`
 *      （ui-workspace 声明、subagent 插件在用），见 `session-menu.tsx`。
 *
 *   ④ 主面板 —— `sidebar.panellist` 图标 + `main` 面板（key 必须逐字相同，见下）。
 *
 * ⚠️ 两个 id/key 必须完全一致：宿主点侧栏行时调 `layout.selectPanel(id)`，
 * 它按 `key` 在 main 槽里找 entry；对不上直接抛 "main panel … is not registered"。
 *
 * ⚠️ 座位注册必须在 `ctx.slots.inject(...)` 回调里做，不能放模块顶层：
 * inject 是宿主"这个槽位已经存在"的信号，早于它注册等于往空气里挂 DOM。
 *
 * 注意：这份源码是 ESM。发行包里的 `lib/client.js` 需要被包上宿主的
 * `window.__ModuleLoader__.load({ id, factory })` 外壳（构建步骤负责），
 * 因为客户端 bundle 通过注入的 `require('react')` 取运行时，而不是走裸 ESM 解析。
 */

import { createElement, type ComponentType } from 'react'
import { api } from './api.js'
import { attachSessions, markEphemeral, mountEphemeralMarks } from './ephemeral-marks.js'
import { createPanel } from './panel.js'
import { askSessionMode, mountSessionMemoryUi, pushToast } from './session-menu.js'
import { ConsoleStore } from './state.js'
import { installConsoleStyles } from './styles.js'

export const name = 'dsh-shared-memories'

/** `slots` 提供座位槽，`locale` 提供文案（本轮文案直接写中文，暂不接 locale 字典）。 */
export const inject = ['slots', 'locale']

/** 侧栏图标：24×24 的极简"云 + 三点"，与宿主原生图标的视觉重量对齐。 */
function CloudGlyph(props: { size?: number }): unknown {
  const size = props.size ?? 20
  return createElement(
    'svg',
    {
      width: size,
      height: size,
      viewBox: '0 0 24 24',
      fill: 'none',
      stroke: 'currentColor',
      strokeWidth: 1.6,
      strokeLinecap: 'round',
      strokeLinejoin: 'round',
      'aria-hidden': 'true',
    },
    createElement('path', { d: 'M6.5 18.5a4 4 0 0 1-.4-7.98 5.5 5.5 0 0 1 10.65-1.3A3.75 3.75 0 0 1 17.5 18.5Z' }),
    createElement('circle', { cx: 9.5, cy: 13.5, r: 0.9, fill: 'currentColor', stroke: 'none' }),
    createElement('circle', { cx: 12.5, cy: 13.5, r: 0.9, fill: 'currentColor', stroke: 'none' }),
    createElement('circle', { cx: 15.5, cy: 13.5, r: 0.9, fill: 'currentColor', stroke: 'none' }),
  )
}

/** 宿主的 slots 服务最小面（真实类型不在本包里，只描述用到的方法）。 */
interface SlotsService {
  inject(slotName: string, register: () => () => void): () => void
  register(options: Record<string, unknown>, component: ComponentType<never> | ((props: never) => unknown)): () => void
}

/** `uiWorkspace` 服务里我们真正用到的那几个方法（宿主没发类型声明，只能自己描述）。 */
interface UiWorkspaceLike {
  /** 用户主动新建的入口（侧栏按钮 / session.new 快捷键）：返回 void，失败也只 warn。 */
  startSession?: (workspaceId?: string, options?: StartSessionOptions) => void
  createNamed?: (request?: CreateSessionRequest) => Promise<string>
  archiveSession?: (sessionId: string, options?: { stopActivity?: boolean }) => Promise<void>
}

/** `startSession` 的第二参（宿主内部解构出 agentPreset，其余透传给草稿）。 */
interface StartSessionOptions {
  agentPreset?: string
  prompt?: string
  clearPreviousDraft?: boolean
}

interface CreateSessionRequest {
  workspaceId?: string
  sessionId?: string
  agentPreset?: string
}

/** `uiWorkspace` 与 `workspaces` 共有的归档面（两个服务都有这个方法）。 */
interface WorkspaceArchiveFace {
  archiveSession?: (sessionId: string, options?: { readonly stopActivity?: boolean }) => Promise<void>
}

interface ClientContext {
  slots: SlotsService
  /**
   * cordis 的安全服务查找（`ctx.reflect.get` 的别名，服务缺失时返回 undefined）。
   * 只允许用它读跨插件服务——属性访问在未 inject 时会抛错。
   */
  get?: (serviceName: string) => unknown
  effect?: (runner: () => () => void, label?: string) => void
}

/**
 * 拿到 `uiWorkspace`。
 *
 * ⚠️ **只能用 `ctx.get()`**，绝不能写 `ctx.uiWorkspace` 兜底：
 * cordis 的 Context 是 Proxy，未在 `inject` 里声明的服务，属性访问会直接抛
 * `cannot get property "uiWorkspace" without inject` —— 在 apply 期间抛就是
 * 整个客户端插件 fiber failed，桌面端直接弹"应用无法启动"。
 * 而 `uiWorkspace` 是别的插件提供的，时机不确定，我们不能把它写进 inject
 * （写进去就可能永远 pending），所以只能"安全地读不到就先不装"。
 */
function workspaceOf(ctx: ClientContext): UiWorkspaceLike | undefined {
  if (typeof ctx.get !== 'function') return undefined
  const service = ctx.get('uiWorkspace')
  if (service === undefined || service === null) return undefined
  return service as UiWorkspaceLike
}

/**
 * 把任何形态的失败对象转成一句人话。
 *
 * HTTP 层抛的是 `ApiError {code, message}`（普通对象，不是 Error），
 * `String(obj)` 只会得到 `[object Object]` —— 用户看到的
 * "会话策略写入失败（[object Object]）"就是漏了这一层的后果。
 */
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

/**
 * 归档会话（菜单三项共用）：先停掉在跑的活动，再归档。
 *
 * 为什么写成"多面 + 重试"：
 * - `uiWorkspace` 是 UI 门面，`workspaces` 是 Workspace Controller 的门面，
 *   两者都有 `archiveSession`。哪个先就绪就用哪个，别因为一个读不到就让侧栏留空壳。
 * - 带 `stopActivity` 的那次失败最常见（会话正在跑、provider 拒绝停），
 *   退一步用不带选项的写法；再失败就隔 150ms 重试一次——归档是**持久化写**，
 *   有时候第一次只是撞上会话刚被关掉的中间态。
 * - 全部失败才抛，并且带上每次的真实原因：前端要能弹出来，
 *   而不是像以前那样被 `.catch(() => undefined)` 吞掉，用户只看到一个点不开的空壳。
 */
async function archiveSessionOf(ctx: ClientContext, sessionId: string): Promise<void> {
  const faces: WorkspaceArchiveFace[] = []
  const ui = workspaceOf(ctx) as WorkspaceArchiveFace | undefined
  if (ui !== undefined) faces.push(ui)
  const controller = ctx.get?.('workspaces') as WorkspaceArchiveFace | undefined
  if (controller !== undefined && controller !== null && controller !== ui) faces.push(controller)

  const callable = faces.filter((face) => typeof face.archiveSession === 'function')
  if (callable.length === 0) {
    throw new Error('宿主未提供会话归档服务（uiWorkspace / workspaces）')
  }

  const reasons: string[] = []
  for (let round = 0; round < 2; round += 1) {
    if (round > 0) await delay(150)
    for (const face of callable) {
      for (const options of [{ stopActivity: true }, undefined]) {
        try {
          await face.archiveSession?.(sessionId, options)
          return
        } catch (cause) {
          reasons.push(messageOf(cause))
        }
      }
    }
  }
  throw new Error(`会话归档失败：${reasons[reasons.length - 1] ?? '未知错误'}`)
}

function delay(ms: number): Promise<void> {
  return new Promise<void>((resolve) => {
    window.setTimeout(resolve, ms)
  })
}

/**
 * 归档落库之后再推一把界面：侧栏的数据源在宿主手里，
 * 我们能做的是让它把这条会话的投影重新算一遍（人格 / 标题 / 会话头都在这层）。
 * 失败无所谓——归档本身已经持久化，下次刷新自然不会再有那一行。
 */
async function resyncAfterPurge(ctx: ClientContext, sessionId: string): Promise<void> {
  const sessions = ctx.get?.('sessions') as
    | { refreshProjections?: (id: string) => Promise<void> }
    | undefined
  if (sessions === undefined || sessions === null) return
  if (typeof sessions.refreshProjections !== 'function') return
  await sessions.refreshProjections(sessionId)
}

/* ── 新建会话拦截（两层） ──────────────────────────────────────────────── */

/** 服务是别的插件提供的，可能比我们晚就绪：短轮询等它，最多 10 秒。 */
const ATTACH_RETRY_MS = 250
const ATTACH_ATTEMPTS = 40

/**
 * "刚问过用户"的标记能活多久。用户点了"新会话"却卡在目录选择 / 预设选择上时，
 * 真正落到 `createNamed` 可能是几秒后；再久就不是同一次新建了，宁可当没问过。
 */
const ARMED_TTL_MS = 15_000

/**
 * 新建会话的二选一，为什么分两层：
 *
 * - **第一层 `startSession`**：这才是"用户想新建"的信号。侧栏按钮、`session.new`
 *   快捷键、加工作区后的自动开新，都从这里进。弹窗挂这儿，用户一点就看到选择框。
 * - **第二层 `createNamed`**：真正的建会话动作。**冷启动 / 切工作区的自动连接也走它**，
 *   但**不经过** `startSession`——所以这里不能无条件弹窗，否则用户切个工作区
 *   就被糊一脸"正常还是无痕"。
 *
 * 于是：第一层问完把答案存进闭包（armed），第二层消费它。
 * 有标记 → 写完 policy 才返回（策略必须先于第一条消息）；
 * 没有标记 → 原样透传，一个字都不改。
 *
 * ⚠️ 还有个坑：宿主会**复用空白会话**——`createInWorkspace` 发现工作区里有
 * `blank` 会话就直接 `createNamed({sessionId: blank})`。所以"带 sessionId"
 * 不等于"不是新建"，armed 必须照样消费，策略写到真正返回的那个 id 上。
 */
function guardNewSession(ctx: ClientContext): () => void {
  let disposed = false
  let timer: number | null = null
  let restore: (() => void) | null = null
  let attempt = 0

  const attach = (): void => {
    if (disposed || restore !== null) return
    const service = workspaceOf(ctx)
    if (
      service !== undefined &&
      typeof service.createNamed === 'function' &&
      typeof service.startSession === 'function'
    ) {
      restore = patchSessionCreation(service)
      return
    }
    attempt += 1
    if (attempt < ATTACH_ATTEMPTS) {
      timer = window.setTimeout(attach, ATTACH_RETRY_MS)
    } else {
      console.warn('[shared-memories] 没等到 uiWorkspace 服务：新建会话的二选一未启用')
    }
  }

  attach()

  return () => {
    disposed = true
    if (timer !== null) window.clearTimeout(timer)
    restore?.()
  }
}

function patchSessionCreation(service: UiWorkspaceLike): () => void {
  const originalCreate = service.createNamed?.bind(service)
  const originalStart = service.startSession?.bind(service)
  if (originalCreate === undefined || originalStart === undefined) return () => undefined

  const previousCreate = service.createNamed
  const previousStart = service.startSession

  /** 第一层问到的答案：一次性消费，带时间戳防"用户逛了半天又把旧答案用掉"。 */
  let armed: { ephemeral: boolean; at: number } | null = null

  service.startSession = (workspaceId?: string, options?: StartSessionOptions): void => {
    void (async () => {
      let choice: Awaited<ReturnType<typeof askSessionMode>>
      try {
        choice = await askSessionMode(workspaceId ?? '')
      } catch (cause) {
        pushToast('error', `新建会话的选择框没能弹出来（${messageOf(cause)}）`)
        return
      }
      // 取消 = 什么都不做。宿主这个方法是 void，返回即"没建"，不会留下半截会话。
      if (choice === null) return
      armed = { ephemeral: choice.ephemeral, at: Date.now() }
      originalStart(workspaceId, options)
    })()
  }

  service.createNamed = async (request?: CreateSessionRequest): Promise<string> => {
    const pending = armed
    armed = null
    const fresh = pending !== null && Date.now() - pending.at <= ARMED_TTL_MS

    const sessionId = await originalCreate(request)

    // 自动连接（冷启动 / 切工作区）：不给用户添麻烦，也不写策略——默认就是"正常"。
    if (!fresh) return sessionId

    // ⚠️ 这一步必须在这里做完：`createNamed` 返回之后宿主立刻打开会话，
    // 用户马上就能打字。策略晚一步落库，就等于给"无痕会话"开了一个口子。
    try {
      await api.saveSessionPolicy({ sessionId, agentId: sessionId, ephemeral: pending.ephemeral })
      // 补上持久标识：聊天头徽标 + 侧栏小幽灵 + 整窗暖色警戒线，全部立刻点亮，
      // 不等下一次策略轮询（否则用户会在头 2.5 秒里以为这是普通会话）。
      markEphemeral(sessionId, pending.ephemeral)
      pushToast(
        'ok',
        pending.ephemeral
          ? '无痕会话已创建：不写记忆、不进快照、不留人格'
          : '会话已创建：记忆可读可写，对话会被提炼进长期记忆',
      )
    } catch (cause) {
      // 写失败必须让用户看见：他以为无痕，下一句其实就进库了。
      pushToast('error', `会话策略写入失败（${messageOf(cause)}）：本会话请勿输入敏感内容`)
    }
    return sessionId
  }

  return () => {
    service.createNamed = previousCreate
    service.startSession = previousStart
  }
}

/* ── 装配 ─────────────────────────────────────────────────────────────── */

/**
 * 装配期的"单点隔离"：任何一块附加功能（菜单行、浮层、新建拦截）失败，
 * 只记一条 console.error，**绝不让 apply 抛出去**。
 *
 * 为什么这么苛刻：客户端的 apply 抛错 = cordis fiber failed = 桌面端弹
 * "应用无法启动或已意外停止"，用户连聊天都进不去。插件只是"记忆增强"，
 * 不该有把整个客户端带下线的权力。
 */
function isolated(step: string, run: () => void): void {
  try {
    run()
  } catch (error) {
    console.error(`[shared-memories] ${step} 装配失败（不影响对话）：`, error)
  }
}

export const apply = (ctx: unknown): void => {
  // 与 host 侧一致：只在入口收窄一次，客户端源码不依赖宿主的类型包。
  const root = ctx as ClientContext
  const slots = root.slots

  // 样式先注入：菜单行/浮层可能比面板更早出现（用户先点会话行「⋯」）。
  isolated('样式注入', () => installConsoleStyles())

  // 一份 store 三处用：面板 / 菜单行 / 浮层。分开建就看不到彼此的进度与 toast。
  const store = new ConsoleStore()
  const disposers: Array<() => void> = []

  isolated('会话菜单与浮层', () => {
    disposers.push(
      mountSessionMemoryUi({
        slots,
        store,
        archiveSession: (sessionId) => archiveSessionOf(root, sessionId),
        resyncSessions: (sessionId) => resyncAfterPurge(root, sessionId),
      }),
    )
  })
  isolated('新建会话拦截', () => {
    disposers.push(guardNewSession(root))
  })
  isolated('无痕标识', () => {
    // 先接上 sessions 服务：顶部警告带要知道"主视图现在是哪条会话"，
    // 光靠新建时那一下点亮，用户一切走就判不出来了。
    disposers.push(attachSessions(root.get?.('sessions') as Parameters<typeof attachSessions>[0]))
    disposers.push(mountEphemeralMarks(slots))
  })

  isolated('侧栏与主面板', () => {
    slots.inject('sidebar.panellist', () => {
      // 这个回调在 slots 的 effect 里跑：抛错同样会把 fiber 打挂，
      // 所以里面每个 register 也各自兜底——面板挂不上顶多少一个图标，不能拖死启动。
      const offs: Array<() => void> = []
      try {
        offs.push(
          slots.register(
            {
              name: 'sidebar.panellist',
              id: 'dsh-shared-memories',
              // 排在 mneme(60)/choro(61)/kb(62) 之后：不抢别人的位置，但也不能沉底。
              order: 63,
              label: () => '共享记忆',
            },
            CloudGlyph as unknown as ComponentType<never>,
          ),
        )

        // ⚠️ 必须用 `createPanel().root`，不能直接 `createElement(Panel)`：
        // Panel 内部走 `useStore()` 读 ConsoleContext，而 Provider 正是在 createPanel
        // 里包上去的。少了这一层，宿主点到这个面板就是一句 "context is undefined"。
        // 建一次、复用元素：每次渲染都 createPanel() 会重置 store，切个视图状态全丢。
        const panel = createPanel(store)

        offs.push(
          slots.register(
            { name: 'main', key: 'dsh-shared-memories' },
            (() => panel.root) as unknown as ComponentType<never>,
          ),
        )
      } catch (error) {
        console.error('[shared-memories] 主面板装配失败（不影响对话）：', error)
      }

      return () => {
        for (const off of offs.reverse()) off()
      }
    })
  })

  // 插件卸载时把菜单行/浮层/拦截器一起摘掉，别把回调用成悬空引用。
  isolated('卸载钩子', () => {
    root.effect?.(() => () => {
      for (const dispose of disposers) dispose()
    }, 'dsh-shared-memories: session ui')
  })
}
