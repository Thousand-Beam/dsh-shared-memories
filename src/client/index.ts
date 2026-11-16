/**
 * dsh-shared-memories — 客户端插件入口（Web 控制台装配）
 * ---------------------------------------------------------------------------
 * 挂两个座位，一一对应 mneme 的成熟做法：
 *
 *   ① `sidebar.panellist` —— 侧栏那一格图标（id 必须与 main 的 key 逐字相同）
 *   ② `main`              —— 点开后的主面板（key = 'dsh-shared-memories'）
 *
 * ⚠️ 两个 id/key 必须完全一致：宿主点侧栏行时调 `layout.selectPanel(id)`，
 * 它按 `key` 在 main 槽里找 entry；对不上直接抛 "main panel … is not registered"。
 * 这是 mneme 在 issue #562 里踩过的坑，这里照抄结论而不是再踩一遍。
 *
 * ⚠️ 座位注册必须在 `ctx.slots.inject(...)` 回调里做，不能放模块顶层：
 * inject 是宿主"这个槽位已经存在"的信号，早于它注册等于往空气里挂 DOM。
 *
 * 注意：这份源码是 ESM。发行包里的 `lib/client.js` 需要被包上宿主的
 * `window.__ModuleLoader__.load({ id, factory })` 外壳（构建步骤负责），
 * 因为客户端 bundle 通过注入的 `require('react')` 取运行时，而不是走裸 ESM 解析。
 */

import { createElement, type ComponentType } from 'react'
import { createPanel } from './panel.js'

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

export const apply = (ctx: unknown): void => {
  // 与 host 侧一致：只在入口收窄一次，客户端源码不依赖宿主的类型包。
  const slots = (ctx as { slots: SlotsService }).slots

  slots.inject('sidebar.panellist', () => {
    const disposeGlyph = slots.register(
      {
        name: 'sidebar.panellist',
        id: 'dsh-shared-memories',
        // 排在 mneme(60)/choro(61)/kb(62) 之后：不抢别人的位置，但也不能沉底。
        order: 63,
        label: () => '共享记忆',
      },
      CloudGlyph as unknown as ComponentType<never>,
    )

    // ⚠️ 必须用 `createPanel().root`，不能直接 `createElement(Panel)`：
    // Panel 内部走 `useStore()` 读 ConsoleContext，而 Provider 正是在 createPanel
    // 里包上去的。少了这一层，宿主点到这个面板就是一句 "context is undefined"。
    // 建一次、复用元素：每次渲染都 createPanel() 会重置 store，切个视图状态全丢。
    const panel = createPanel()

    const disposeMain = slots.register(
      { name: 'main', key: 'dsh-shared-memories' },
      (() => panel.root) as unknown as ComponentType<never>,
    )

    return () => {
      disposeGlyph()
      disposeMain()
    }
  })
}
