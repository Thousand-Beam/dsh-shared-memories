/**
 * dsh-shared-memories — 控制台装配（client/panel.tsx）
 * ---------------------------------------------------------------------------
 * 这是整个 UI 的壳：侧栏导航 + 顶栏（Agent 切换 / 测试连接 / 手动保存）+ 内容区。
 *
 * 三个必须守住的行为（上一版踩过）：
 *   ① `createPanel()` 只调用一次，store 跟着 root 一起活；每次 render 新建 store
 *      会让切 Agent、筛选、toast 全部失忆；
 *   ② bootstrap 失败时必须**同时**把 status 和 phase 都打到 degraded，
 *      只改 status 的话 `booting` 仍为真，骨架屏会永远盖住错误横幅；
 *   ③ 相位没走完（非 ready/degraded）时按 1.5s 轮询一次 bootstrap，
 *      恢复链路是后台推进的，前端不会收到推送。
 */

import { createElement, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import type { AgentSummary, UserProfileDto } from '../shared/console-api.js'
import { api } from './api.js'
import { ConsoleContext, ConsoleStore, useConsole, useStore, type ViewKey } from './state.js'
import { installConsoleStyles } from './styles.js'
import { phaseLabel, reasonLabel, traitLabel } from './i18n.js'
import { agentLabel, formatRelative, shortCode, workspaceLabel } from './format.js'
import { HistoryView } from './history.js'
import { MemoryView } from './memory-list.js'
import { RulesView } from './rules.js'
import { CardSkeleton, ChevronIcon, EmptyState, PhaseBanner, SkeletonLine, StatusDot, Tag, Toast } from './ui.js'

type NavItem = { key: ViewKey; label: string; hint: string; glyph: string }

const NAV: ReadonlyArray<NavItem> = [
  { key: 'memory', label: '记忆总览', hint: '条目 / 筛选 / 情感', glyph: '◍' },
  { key: 'snapshots', label: '快照时间轴', hint: '版本 / 钉住 / 回退', glyph: '🕒' },
  { key: 'rules', label: '规则与人格', hint: '四阶升格 / 落锁', glyph: '🧬' },
  { key: 'quarantine', label: '隔离区', hint: '可疑条目处置', glyph: '🧯' },
  { key: 'overview', label: '全局总览', hint: 'Agent 与工作区', glyph: '◎' },
]

/* ── 装配 ─────────────────────────────────────────────────────────────── */

export function createPanel(): { root: ReactNode; store: ConsoleStore } {
  // 样式在装配期就注入：宿主可能在骨架屏阶段就把面板挂上来，
  // 晚一步注入就会先闪一下无样式裸排版。
  installConsoleStyles()
  const store = new ConsoleStore()
  const root = createElement(
    ConsoleContext.Provider,
    { value: store },
    createElement(Panel),
  )
  return { root, store }
}

/* ── 壳 ───────────────────────────────────────────────────────────────── */

function Panel(): ReactNode {
  const store = useStore()
  const state = useConsole((snapshot) => snapshot)
  const [busy, setBusy] = useState<'test' | 'save' | null>(null)

  const booting =
    state.status === 'loading' ||
    (state.agents.length === 0 && state.phase !== 'ready' && state.phase !== 'degraded')

  const load = async (): Promise<void> => {
    try {
      const boot = await api.bootstrap()
      store.patch({
        status: 'ready',
        phase: boot.phase,
        phaseDetail: boot.phaseDetail,
        agents: boot.agents,
        activeAgentId: boot.activeAgentId,
        snapshotKeep: boot.snapshotKeep,
        allowGlobalSearch: boot.allowGlobalSearch,
        workspaceId: boot.workspaceId,
        deviceId: boot.deviceId,
        error: null,
      })
    } catch (cause) {
      store.patch({
        status: 'degraded',
        phase: 'degraded',
        phaseDetail: cause instanceof Error ? cause.message : String(cause),
        error: cause instanceof Error ? cause.message : String(cause),
      })
    }
  }

  // 首次挂载：拉 bootstrap。
  useEffect(() => {
    void load()
  }, [])

  // 相位未收敛：轮询。ready/degraded 之后自动停。
  useEffect(() => {
    if (state.phase === 'ready' || state.phase === 'degraded') return
    const timer = window.setInterval(() => {
      void load()
    }, 1500)
    return () => window.clearInterval(timer)
  }, [state.phase])

  // 切 Agent：三份数据一起拉，避免出现"卡片是 A 的、时间轴是 B 的"。
  useEffect(() => {
    const agentId = state.activeAgentId
    if (agentId === '') return
    let cancelled = false
    void (async () => {
      try {
        const [memories, snapshots, quarantine] = await Promise.all([
          api.memories({ agentId, global: state.filters.global }),
          api.snapshots(agentId),
          api.quarantine(agentId),
        ])
        if (!cancelled) store.patch({ memories, snapshots, quarantine })
      } catch (cause) {
        if (!cancelled) store.toast('error', cause instanceof Error ? cause.message : '载入该 Agent 的数据失败')
      }
    })()
    return () => {
      cancelled = true
    }
  }, [state.activeAgentId])

  const test = async (): Promise<void> => {
    setBusy('test')
    try {
      const result = await api.testConnection()
      store.toast(result.ok ? 'ok' : 'error', result.ok ? `连接正常（${result.detail}）` : `连接异常：${result.detail}`)
    } catch (cause) {
      store.toast('error', cause instanceof Error ? cause.message : '测试连接失败')
    } finally {
      setBusy(null)
    }
  }

  const saveNow = async (): Promise<void> => {
    setBusy('save')
    try {
      const snapshot = await api.saveNow()
      store.toast('ok', '已保存新快照')
      const [snapshots, memories] = await Promise.all([
        api.snapshots(state.activeAgentId),
        api.memories({ agentId: state.activeAgentId, global: state.filters.global }),
      ])
      store.patch({ snapshots, memories })
    } catch (cause) {
      store.toast('error', cause instanceof Error ? cause.message : '手动保存失败')
    } finally {
      setBusy(null)
    }
  }

  if (booting) {
    return (
      <div className='dsm-root'>
        <aside className='dsm-sidebar'>
          <div className='dsm-brand'>
            <div className='dsm-brand-title'>共享记忆</div>
            <div className='dsm-brand-sub'>正在冷启动恢复…</div>
          </div>
          {NAV.map((item) => (
            <div key={item.key} style={{ padding: '8px 10px' }}>
              <SkeletonLine width={item.label.length * 13} height={12} />
            </div>
          ))}
        </aside>
        <div className='dsm-main'>
          <div className='dsm-loading'>
            <div className='dsm-spinner' />
            <div className='dsm-loading-text'>{phaseLabel(state.phase)}</div>
            {state.phaseDetail === '' ? null : <div className='dsm-loading-detail'>{state.phaseDetail}</div>}
          </div>
        </div>
      </div>
    )
  }

  return (
    <div className='dsm-root'>
      <aside className='dsm-sidebar'>
        <div className='dsm-brand'>
          <div className='dsm-brand-title'>
            <span className='dsm-brand-mark' aria-hidden='true'>
              ☁
            </span>
            共享记忆
          </div>
          <div className='dsm-brand-sub'>跨 Agent 的长期记忆底座</div>
        </div>

        <nav className='dsm-stack' style={{ gap: 4 }}>
          {NAV.map((item) => (
            <button
              key={item.key}
              type='button'
              className='dsm-nav'
              data-active={state.view === item.key}
              onClick={() => store.setView(item.key)}
            >
              <span className='dsm-nav-icon' aria-hidden='true'>
                {item.glyph}
              </span>
              <span className='dsm-nav-text'>
                {item.label}
                <span className='dsm-nav-hint'>{item.hint}</span>
              </span>
            </button>
          ))}
        </nav>

        <div className='dsm-sidebar-foot'>
          <div className='dsm-truncate' title={state.workspaceId === '' ? '尚未挂到具体目录' : state.workspaceId}>
            {workspaceLabel(state.workspaceId)}
          </div>
          <div className='dsm-truncate' title={state.deviceId}>
            设备 {state.deviceId === '' ? '—' : shortCode(state.deviceId, 6)}
          </div>
          <div>
            快照保留 {state.snapshotKeep} 个
          </div>
        </div>
      </aside>

      <div className='dsm-main'>
        <header className='dsm-header'>
          <AgentSwitcher agents={state.agents} activeAgentId={state.activeAgentId} onPick={(id) => store.setActiveAgent(id)} />
          <span className='dsm-spacer' />
          <span className='dsm-caption' title={state.phaseDetail ?? undefined}>
            <StatusDot tone={state.phase === 'ready' ? 'ok' : state.phase === 'degraded' ? 'danger' : 'warn'} />
            <span style={{ marginLeft: 6 }}>{phaseLabel(state.phase)}</span>
          </span>
          <button type='button' className='dsm-btn dsm-btn--sm' onClick={() => void test()} disabled={busy !== null}>
            {busy === 'test' ? '测试中…' : '测试连接'}
          </button>
          <button type='button' className='dsm-btn dsm-btn--sm dsm-btn--primary' onClick={() => void saveNow()} disabled={busy !== null}>
            {busy === 'save' ? '保存中…' : '手动保存'}
          </button>
        </header>

        <div className='dsm-nav-inline'>
          {NAV.map((item) => (
            <button
              key={item.key}
              type='button'
              className='dsm-pill'
              data-active={state.view === item.key}
              onClick={() => store.setView(item.key)}
            >
              {item.label}
            </button>
          ))}
        </div>

        <PhaseBanner
          phase={state.phase}
          detail={state.phaseDetail}
          onRetry={() => {
            store.patch({ status: 'loading', phase: 'cold', phaseDetail: '' })
            void load()
          }}
        />

        <div className='dsm-content'>
          {state.view === 'memory' ? <MemoryView /> : null}
          {state.view === 'snapshots' ? <HistoryView /> : null}
          {state.view === 'rules' ? <RulesView /> : null}
          {state.view === 'quarantine' ? <QuarantineView /> : null}
          {state.view === 'overview' ? <OverviewView /> : null}
        </div>
      </div>

      {state.toast === null ? null : <Toast kind={state.toast.kind} message={state.toast.message} />}
    </div>
  )
}

/* ── Agent 切换 ───────────────────────────────────────────────────────── */

/**
 * 下拉菜单必须挂到 `document.body`。
 *
 * 为什么绝对定位怎么调都不行：面板内部到处都是 `overflow: hidden` / `auto`
 * 的滚动容器，顶部 header 还带 `backdrop-filter`（自成层叠上下文）。
 * 只要菜单是这些元素的后代，z-index 写得再大也只在自己那一层里比大小，
 * 出了这一层照样被后面的内容区盖住 —— 这是层叠上下文，不是 z-index 不够。
 *
 * 所以改成 Portal + `position: fixed` + 按钮实测坐标：菜单不再属于任何
 * 祖先的裁剪盒，只剩全局一个 z-index（1000）要管。窗口缩放/滚动时重算坐标。
 */
function AgentSwitcher(props: {
  agents: AgentSummary[]
  activeAgentId: string
  onPick: (agentId: string) => void
}): ReactNode {
  const [open, setOpen] = useState(false)
  const [anchor, setAnchor] = useState<{ top: number; left: number; minWidth: number } | null>(null)
  const buttonRef = useRef<HTMLButtonElement | null>(null)
  const menuRef = useRef<HTMLDivElement | null>(null)

  const active = props.agents.find((agent) => agent.agentId === props.activeAgentId)
  const label = active === undefined ? '未选择 Agent' : agentLabel(active)

  const measure = useMemo(
    () => (): void => {
      const el = buttonRef.current
      if (el === null) return
      const rect = el.getBoundingClientRect()
      const MENU_MAX = 320
      const GUTTER = 12
      const width = Math.min(MENU_MAX, Math.max(220, rect.width))
      // 右边放不下就朝左对齐，保证永远不出窗口。
      const left = Math.max(GUTTER, Math.min(rect.left, window.innerWidth - width - GUTTER))
      setAnchor({ top: Math.round(rect.bottom + 6), left: Math.round(left), minWidth: Math.round(width) })
    },
    [],
  )

  useEffect(() => {
    if (!open) {
      setAnchor(null)
      return
    }
    measure()
    const onDown = (event: MouseEvent): void => {
      const target = event.target
      if (!(target instanceof Node)) return
      // 菜单在 body 上，不再是按钮的兄弟节点，判定要连着两棵树一起看。
      if (buttonRef.current !== null && buttonRef.current.contains(target)) return
      if (menuRef.current !== null && menuRef.current.contains(target)) return
      setOpen(false)
    }
    // Esc 关菜单：键盘用户不该被一个只能用鼠标关的浮层困住。
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') setOpen(false)
    }
    const onScroll = (): void => measure()
    window.addEventListener('mousedown', onDown)
    window.addEventListener('keydown', onKey)
    window.addEventListener('resize', onScroll)
    // capture 阶段收滚动：面板内滚动容器不会冒泡到 window。
    window.addEventListener('scroll', onScroll, true)
    return () => {
      window.removeEventListener('mousedown', onDown)
      window.removeEventListener('keydown', onKey)
      window.removeEventListener('resize', onScroll)
      window.removeEventListener('scroll', onScroll, true)
    }
  }, [open, measure])

  const menu =
    open && anchor !== null
      ? createPortal(
          <div
            ref={menuRef}
            className='dsm-menu dsm-menu--portal'
            data-dsm-menu='true'
            role='menu'
            style={{ top: anchor.top, left: anchor.left, minWidth: anchor.minWidth }}
          >
            {props.agents.length === 0 ? (
              <div className='dsm-menu-empty'>还没有注册任何 Agent</div>
            ) : (
              props.agents.map((agent) => {
                // 名字缺失时说「未命名会话」，代号只留一份在右侧，别同一行写两遍。
                const named = (agent.name ?? '').trim()
                const shortName = named !== '' ? named : '未命名会话'
                return (
                  <button
                    key={agent.agentId}
                    type='button'
                    role='menuitem'
                    className='dsm-menu-item'
                    data-active={agent.agentId === props.activeAgentId}
                    title={agent.agentId}
                    onClick={() => {
                      setOpen(false)
                      props.onPick(agent.agentId)
                    }}
                  >
                    <span className='dsm-avatar' aria-hidden='true'>
                      {shortName.slice(0, 1)}
                    </span>
                    <span className='dsm-menu-name'>{shortName}</span>
                    <span className='dsm-menu-meta'>{`#${shortCode(agent.agentId)}`}</span>
                  </button>
                )
              })
            )}
          </div>,
          document.body,
        )
      : null

  return (
    <div className='dsm-menu-wrap'>
      <button
        ref={buttonRef}
        type='button'
        className='dsm-agent-btn'
        aria-haspopup='menu'
        aria-expanded={open}
        title={active === undefined ? undefined : `${agentLabel(active)}（完整 id：${active.agentId}）`}
        onClick={() => setOpen((value) => !value)}
      >
        <span className='dsm-avatar' aria-hidden='true'>
          {label.slice(0, 1)}
        </span>
        <span style={{ maxWidth: 140, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
          {label}
        </span>
        <ChevronIcon open={open} />
      </button>
      {menu}
    </div>
  )
}

/* ── 隔离区 ───────────────────────────────────────────────────────────── */

function QuarantineView(): ReactNode {
  const store = useStore()
  const state = useConsole((snapshot) => snapshot)

  const act = async (kind: 'approve' | 'destroy', quarantineId: string): Promise<void> => {
    try {
      if (kind === 'approve') await api.approve(quarantineId, 'user')
      else await api.destroy(quarantineId, 'user')
      const rows = await api.quarantine(state.activeAgentId)
      store.patch({ quarantine: rows })
      store.toast('ok', kind === 'approve' ? '已放行，条目回到正常记忆池' : '已销毁该条目')
    } catch (cause) {
      store.toast('error', cause instanceof Error ? cause.message : '处置失败')
    }
  }

  return (
    <div className='dsm-page'>
      <div className='dsm-card dsm-card--flat'>
        <div className='dsm-row' style={{ gap: 10 }}>
          <span className='dsm-h2'>隔离区</span>
          <Tag tone='outline'>{state.quarantine.length} 条待处置</Tag>
          <span className='dsm-spacer' />
          <span className='dsm-caption'>低信任或可疑来源的记忆会先落到这里，不会直接进上下文</span>
        </div>
      </div>

      {state.quarantine.length === 0 ? (
        <EmptyState icon='✅' title='隔离区是空的' hint='没有条目被拦下来，说明最近的写入都过了信任检查。' />
      ) : (
        <div className='dsm-stack'>
          {state.quarantine.map((item) => (
            <article className='dsm-card' key={item.quarantineId}>
              <div className='dsm-card-head'>
                <Tag tone='danger'>已隔离</Tag>
                <Tag tone='idle'>风险分 {Math.round(item.score * 100)}%</Tag>
                <span className='dsm-spacer' />
                <span className='dsm-caption'>{formatRelative(item.createdAt)}</span>
              </div>
              <div className='dsm-card-body' title={item.reason}>
                {reasonLabel(item.reason)}
              </div>
              <div className='dsm-card-foot'>
                <span className='dsm-mono dsm-truncate' style={{ maxWidth: '60%' }} title={item.payload}>
                  {item.payload}
                </span>
                <span className='dsm-spacer' />
                <button type='button' className='dsm-btn dsm-btn--sm dsm-btn--ghost' onClick={() => void act('destroy', item.quarantineId)}>
                  销毁
                </button>
                <button type='button' className='dsm-btn dsm-btn--sm' onClick={() => void act('approve', item.quarantineId)}>
                  放行
                </button>
              </div>
            </article>
          ))}
        </div>
      )}
    </div>
  )
}

/* ── 全局总览 ─────────────────────────────────────────────────────────── */

/**
 * 用户画像：这是"新会话失忆"的正面修复。
 * 它按工作区存、跨 Agent 共享，所以这块 UI 不跟随 Agent 切换。
 * 没有它，模型就只能从 README 署名、设备名里猜一个名字——上一版猜出来的就是仓库作者名。
 */
function UserProfileCard(): ReactNode {
  const store = useStore()
  const [profile, setProfile] = useState<UserProfileDto | null>(null)
  const [name, setName] = useState('')
  const [address, setAddress] = useState('')
  const [notes, setNotes] = useState('')
  const [busy, setBusy] = useState(false)
  const [failed, setFailed] = useState(false)

  useEffect(() => {
    let alive = true
    void api
      .userProfile()
      .then((loaded) => {
        if (!alive) return
        setProfile(loaded)
        setName(loaded.displayName)
        setAddress(loaded.preferredAddress)
        setNotes(loaded.notes)
      })
      .catch(() => {
        if (alive) setFailed(true)
      })
    return () => {
      alive = false
    }
  }, [])

  const save = async (): Promise<void> => {
    setBusy(true)
    try {
      const saved = await api.saveUserProfile({ displayName: name, preferredAddress: address, notes })
      setProfile(saved)
      setName(saved.displayName)
      setAddress(saved.preferredAddress)
      setNotes(saved.notes)
      store.toast('ok', saved.displayName === '' ? '画像已清空' : `已记住：${saved.address}`)
    } catch (cause) {
      store.toast('error', cause instanceof Error ? cause.message : '保存失败')
    } finally {
      setBusy(false)
    }
  }

  const empty = profile !== null && profile.displayName === '' && profile.preferredAddress === '' && profile.notes === ''

  return (
    <div className='dsm-card dsm-card--flat'>
      <div className='dsm-row dsm-row--wrap' style={{ gap: 8 }}>
        <span className='dsm-h3'>用户画像</span>
        <Tag tone={empty ? 'idle' : 'ok'} title='按工作区保存，跨 Agent 共享'>
          {empty ? '未记录' : `已记住 · ${profile?.address ?? ''}`}
        </Tag>
        <span className='dsm-spacer' />
        <span className='dsm-caption'>换会话、换 Agent 都会带上它</span>
      </div>

      {failed ? (
        <div className='dsm-caption' style={{ marginTop: 8 }}>
          读取画像失败，宿主可能还没升级到这一版路由。
        </div>
      ) : (
        <>
          <div className='dsm-form-grid' style={{ marginTop: 10 }}>
            <div className='dsm-field'>
              <span className='dsm-caption'>名字</span>
              <input
                className='dsm-input'
                value={name}
                placeholder='比如 张三'
                onChange={(event) => setName(event.target.value)}
              />
            </div>
            <div className='dsm-field'>
              <span className='dsm-caption'>希望怎么称呼</span>
              <input
                className='dsm-input'
                value={address}
                placeholder='比如 老张（留空就用名字）'
                onChange={(event) => setAddress(event.target.value)}
              />
            </div>
            <div className='dsm-field' style={{ gridColumn: '1 / -1' }}>
              <span className='dsm-caption'>偏好备注（单行，会被折进提示）</span>
              <input
                className='dsm-input'
                value={notes}
                placeholder='比如 偏好简体中文，回答要短'
                onChange={(event) => setNotes(event.target.value)}
              />
            </div>
          </div>
          <div className='dsm-row' style={{ marginTop: 10, gap: 8 }}>
            <button type='button' className='dsm-btn dsm-btn--primary dsm-btn--sm' onClick={() => void save()} disabled={busy}>
              {busy ? '保存中…' : '保存画像'}
            </button>
            <span className='dsm-caption'>
              留空保存等于删掉：没记录时提示会明确要求模型「不要猜」，需要时直接问你。
            </span>
          </div>
        </>
      )}
    </div>
  )
}

function OverviewView(): ReactNode {
  const store = useStore()
  const state = useConsole((snapshot) => snapshot)

  return (
    <div className='dsm-page'>
      <div className='dsm-card dsm-card--flat'>
        <div className='dsm-row dsm-row--wrap' style={{ gap: 10 }}>
          <span className='dsm-h2'>全局总览</span>
          <Tag tone='outline'>{state.agents.length} 个 Agent</Tag>
          <Tag tone={state.allowGlobalSearch ? 'ok' : 'idle'}>
            {state.allowGlobalSearch ? '允许跨 Agent 检索' : '跨 Agent 检索已关闭'}
          </Tag>
          <span className='dsm-spacer' />
          <span className='dsm-caption'>{phaseLabel(state.phase)}</span>
        </div>
      </div>

      {state.agents.length === 0 ? (
        <EmptyState icon='👥' title='还没有 Agent' hint='宿主侧创建 Agent 之后，这里会列出它的人格档案与记忆规模。' />
      ) : (
        <div className='dsm-stack'>
          <UserProfileCard />
          {state.agents.map((agent) => {
            const traits = Object.entries(agent.traits).slice(0, 6)
            // 标题只说人话，代号只在后面出现一次：`未命名会话 · #2b81` + `#2b81` 太吵。
            const title = (agent.name ?? '').trim() !== '' ? (agent.name ?? '').trim() : '未命名会话'
            return (
              <article className='dsm-card' key={agent.agentId}>
                <div className='dsm-card-head'>
                  <span className='dsm-avatar' aria-hidden='true'>
                    {title.slice(0, 1)}
                  </span>
                  <span className='dsm-card-title' title={agent.agentId}>
                    {title}
                  </span>
                  <span className='dsm-caption dsm-mono'>#{shortCode(agent.agentId)}</span>
                  {agent.agentId === state.activeAgentId ? <Tag tone='accent'>当前</Tag> : null}
                  {/* 只显示数量：技能清单跨 Agent 不给看，但"他挂了几个"是排障必需。 */}
                  {typeof agent.skillCount === 'number' && agent.skillCount > 0 ? (
                    <Tag tone='ok' title='当前工作区下已启用的技能数'>
                      技能 {agent.skillCount}
                    </Tag>
                  ) : null}
                  <span className='dsm-spacer' />
                  <span className='dsm-caption' title={agent.workspaceId}>
                    {workspaceLabel(agent.workspaceId)}
                  </span>
                </div>

                {/* 没数据就整行不渲染：一句「还没有性格倾向数据」×N 张卡 = 一屏废话。 */}
                {traits.length === 0 ? null : (
                  <div className='dsm-row dsm-row--wrap' style={{ gap: 6, marginTop: 10 }}>
                    {traits.map(([key, value]) => (
                      <Tag key={key} tone='idle' title={`${traitLabel(key)} ${value.toFixed(2)}`}>
                        {traitLabel(key)} <span className='dsm-num'>{value.toFixed(2)}</span>
                      </Tag>
                    ))}
                  </div>
                )}

                <div className='dsm-card-foot'>
                  {agent.agentId === state.activeAgentId ? (
                    <span className='dsm-caption'>记忆 {state.memories.length} 条</span>
                  ) : (
                    <button
                      type='button'
                      className='dsm-btn dsm-btn--sm dsm-btn--ghost'
                      style={{ height: 22, padding: '0 6px' }}
                      onClick={() => store.setActiveAgent(agent.agentId)}
                    >
                      切换到这个 Agent
                    </button>
                  )}
                  <span className='dsm-spacer' />
                  {traits.length === 0 ? <span className='dsm-caption'>暂无特质</span> : null}
                </div>
              </article>
            )
          })}
        </div>
      )}

      <div className='dsm-card dsm-card--flat'>
        <div className='dsm-row' style={{ gap: 10 }}>
          <span className='dsm-h3'>恢复相位</span>
          <span className='dsm-spacer' />
          <span className='dsm-caption'>{phaseLabel(state.phase)}</span>
        </div>
        {state.phaseDetail === '' ? null : <div className='dsm-caption' style={{ marginTop: 4 }}>{state.phaseDetail}</div>}
      </div>
    </div>
  )
}

/* ── 首屏骨架（booting 之外的兜底） ───────────────────────────────────── */

export function PanelSkeleton(): ReactNode {
  return (
    <div className='dsm-root'>
      <div className='dsm-main'>
        <div className='dsm-content'>
          <div className='dsm-page'>
            <CardSkeleton rows={3} />
            <CardSkeleton rows={4} />
          </div>
        </div>
      </div>
    </div>
  )
}
