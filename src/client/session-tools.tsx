/**
 * dsh-shared-memories — 记忆工具：深度重读 + 提炼进度（client/session-tools.tsx）
 * ---------------------------------------------------------------------------
 * 这里只留两样东西，且**都不带开关**：
 *
 *   深度重读 —— 把当前会话从头到尾重读一遍（Map-Reduce），写进人格记忆
 *   提炼进度 —— 一条细进度条，说清"正在读第几段 / 归并中 / 新增几条"
 *
 * 无痕模式的开关**已经从这里删掉**：它不该是"事后补救"的横条，而必须在
 * 新建会话的那一刻就二选一（见 `session-menu.tsx` 的 NewSessionDialog +
 * `index.ts` 对 `uiWorkspace.createNamed` 的拦截）。总览里再留一个开关，
 * 用户会以为"先聊两句再开无痕"也没问题——那已经晚了。
 *
 * 提炼是"起任务 + 轮询"，不是 await 到底：
 *   `POST /distill` 立刻返回 job，进度靠 `GET /distill/job?jobId=` 追，
 *   轮询必须能被打断（切会话/组件卸载），否则会留一串僵尸定时器。
 */

import { useEffect, useRef, useState, type ReactNode } from 'react'
import { api } from './api.js'
import { progressOf, useConsole, useStore, type ConsoleStore } from './state.js'
import { StatusDot, Tag } from './ui.js'

/** 销毁确认短语：必须逐字输入才能解锁按钮（与菜单弹窗共用）。 */
export const PURGE_PHRASE = '彻底销毁'

/** 轮询间隔：宿主每块提炼约 1-3s，700ms 跟手又不至于把宿主打满。 */
export const POLL_MS = 700

/** 单次提炼的最长等待：会话很长时 Map 阶段可能跑几分钟。 */
const DISTILL_TIMEOUT_MS = 15 * 60 * 1000

/**
 * 会话 id 的取法。
 * DSH 里 `agent.id === session.id`，所以"当前 Agent"就是"当前会话"。
 * 抽成函数是为了将来宿主拆开这两个概念时，只有这一行要改。
 */
export function sessionIdOf(agentId: string): string {
  return agentId
}

/** 一次提炼的最终结果：调用方（菜单动作）据此决定要不要继续归档。 */
export interface DistillOutcome {
  status: 'done' | 'skipped' | 'failed' | 'timeout'
  written: number
  detail: string
  error: string
}

function sleep(ms: number): Promise<void> {
  return new Promise<void>((resolve) => {
    window.setTimeout(resolve, ms)
  })
}

/**
 * 起一次提炼并轮询到终态。
 *
 * @param store      控制台 store（进度写在这里，面板与全局浮层都能看到）
 * @param sessionId  会话 id
 * @param mode       `deep` = 全量重读；`incremental` = 只读新增
 * @param signal     可选中断信号（切会话时调用方 abort）
 */
export async function runDistillJob(
  store: ConsoleStore,
  sessionId: string,
  mode: 'deep' | 'incremental',
  signal?: { aborted: boolean },
): Promise<DistillOutcome> {
  const job = await api.startDistill({ sessionId, mode })
  store.setDistill(progressOf(job))

  let current = job
  const deadline = Date.now() + DISTILL_TIMEOUT_MS

  while (current.status === 'running') {
    if (signal?.aborted === true) {
      // 用户切走了：不要再往 store 里写别人的进度，也不要继续打接口。
      return { status: 'skipped', written: current.written, detail: '已切走，进度不再追踪', error: '' }
    }
    if (Date.now() > deadline) {
      store.setDistill(null)
      return { status: 'timeout', written: current.written, detail: '等待超时', error: '提炼超时（可在宿主日志里查进度）' }
    }
    await sleep(POLL_MS)
    try {
      const next = await api.distillJob({ jobId: job.jobId })
      if (next === null) break
      current = next
      store.setDistill(progressOf(current))
    } catch (cause) {
      store.setDistill(null)
      return {
        status: 'failed',
        written: current.written,
        detail: '',
        error: cause instanceof Error ? cause.message : '查询提炼进度失败',
      }
    }
  }

  const outcome: DistillOutcome = {
    status: current.status === 'running' ? 'timeout' : current.status,
    written: current.written,
    detail: current.detail,
    error: current.error ?? '',
  }
  return outcome
}

/** 进度文案（1 基 chunk 由服务端给，这里不再 +1）。 */
export function progressText(status: string, phase: string, chunk: number, total: number, written: number): string {
  if (status === 'done') return `已完成 · 新增 ${written} 条记忆`
  if (status === 'skipped') return '按策略跳过（无痕或仅归档）'
  if (status === 'failed') return '提炼失败'
  if (phase === 'merging') return '正在归并跨块事实…'
  if (total > 0 && chunk > 0) return `正在提取第 ${Math.min(chunk, total)}/${total} 段…`
  return '正在读取会话…'
}

/* ── 内容区工具条 ─────────────────────────────────────────────────────── */

/**
 * 内容区顶部的那一条：**只有**"深度重读"按钮 + 提炼进度。
 * 无痕状态不在这里展示——它是新建会话时的选择，不是这里的开关。
 */
export function MemoryToolbar(): ReactNode {
  const store = useStore()
  const sessionId = sessionIdOf(useConsole((state) => state.activeAgentId))
  const distill = useConsole((state) => state.distill)

  const [busy, setBusy] = useState(false)
  const abortRef = useRef<{ aborted: boolean } | null>(null)

  // 切会话/卸载：把在飞的那次轮询标记为放弃，别再往新会话的 store 里写。
  useEffect(() => {
    return () => {
      if (abortRef.current !== null) abortRef.current.aborted = true
    }
  }, [sessionId])

  const running = distill !== null && distill.status === 'running'
  const percent =
    distill === null || distill.total <= 0
      ? 0
      : Math.min(100, Math.round((distill.chunk / distill.total) * 100))

  /**
   * 自动提炼的进度跟踪。
   *
   * 记忆现在是"边聊边记"：每轮回答结束后宿主自己跑增量提炼，用户并没有点
   * 任何按钮。所以这里必须**常驻轮询**这一个会话的最新任务，否则用户永远
   * 看不到进度（之前的实现只在点"深度重读"后才轮询，于是自动提炼完全静默）。
   * 用 `lastSeen` 记上一次的 jobId，只在状态翻页时弹一次 Toast。
   */
  useEffect(() => {
    if (sessionId === '') return
    let cancelled = false
    let lastJobId = ''
    let lastStatus = ''
    const timer = window.setInterval(() => {
      void (async () => {
        try {
          const job = await api.distillJob({ sessionId })
          if (cancelled) return
          if (job === null) return
          const next = progressOf(job)
          store.setDistill(next)
          if (next.jobId !== lastJobId) {
            lastJobId = next.jobId
            lastStatus = ''
          }
          if (lastStatus === 'running' && next.status === 'done' && next.written > 0) {
            store.toast('ok', `已自动记住 ${next.written} 条新记忆`)
            const state = store.getState()
            const [memories, snapshots] = await Promise.all([
              api.memories({ agentId: state.activeAgentId, global: state.filters.global }),
              api.snapshots(state.activeAgentId),
            ])
            if (!cancelled) store.patch({ memories, snapshots })
          }
          lastStatus = next.status
        } catch {
          /* 面板没连上后端时静默：进度是锦上添花，不该刷红条 */
        }
      })()
    }, 3000)
    return () => {
      cancelled = true
      window.clearInterval(timer)
    }
  }, [sessionId, store])

  const runDeep = async (): Promise<void> => {
    if (sessionId === '' || busy || running) return
    setBusy(true)
    const signal = { aborted: false }
    abortRef.current = signal
    try {
      const outcome = await runDistillJob(store, sessionId, 'deep', signal)
      if (outcome.status === 'done') {
        store.toast('ok', `本次深度提取新增 ${outcome.written} 条记忆`)
        // 完成后顺手刷新：用户不用再点一次"重新载入"才看到新条目。
        const state = store.getState()
        const [memories, snapshots] = await Promise.all([
          api.memories({ agentId: state.activeAgentId, global: state.filters.global }),
          api.snapshots(state.activeAgentId),
        ])
        store.patch({ memories, snapshots })
      } else if (outcome.status === 'skipped') {
        store.toast('error', outcome.detail === '' ? '本会话按策略跳过提炼' : outcome.detail)
      } else if (outcome.status === 'failed') {
        store.toast('error', outcome.error === '' ? '提炼失败，详见宿主日志' : outcome.error)
      }
    } catch (cause) {
      store.toast('error', cause instanceof Error ? cause.message : '启动提炼失败')
    } finally {
      abortRef.current = null
      setBusy(false)
    }
  }

  return (
    <div className='dsm-session-bar'>
      <div className='dsm-row dsm-row--wrap' style={{ gap: 10 }}>
        <Tag tone='idle' title='深度重读＝从头重读整段对话，分块提取后归并成长期记忆'>
          深度重读：整段对话分块提取后归并
        </Tag>
        <span className='dsm-spacer' />
        <button
          type='button'
          className='dsm-btn dsm-btn--sm'
          disabled={sessionId === '' || busy || running}
          onClick={() => void runDeep()}
          title='从头重读整段对话，分块提取后归并（会消耗较多算力，需几分钟）'
        >
          {running ? '提取中…' : '深度重读当前对话'}
        </button>
      </div>

      {distill === null ? null : (
        <div className='dsm-session-progress'>
          <div className='dsm-progress' data-tone={distill.status} style={{ flex: 1 }}>
            <i style={{ width: `${distill.status === 'running' ? Math.max(6, percent) : 100}%` }} />
          </div>
          <span className='dsm-caption' title={distill.detail}>
            {progressText(distill.status, distill.phase, distill.chunk, distill.total, distill.written)}
          </span>
          {distill.status === 'running' ? (
            <StatusDot tone='warn' />
          ) : (
            <button
              type='button'
              className='dsm-btn dsm-btn--sm dsm-btn--ghost'
              onClick={() => store.setDistill(null)}
            >
              收起
            </button>
          )}
        </div>
      )}
    </div>
  )
}

/** 垃圾桶图标（菜单与弹窗共用）。 */
export function TrashIcon(): ReactNode {
  return (
    <svg
      width='13'
      height='13'
      viewBox='0 0 24 24'
      fill='none'
      stroke='currentColor'
      strokeWidth='2'
      strokeLinecap='round'
      style={{ marginRight: 6, verticalAlign: '-2px' }}
      aria-hidden='true'
    >
      <path d='M4 7h16M10 4h4M6 7l1 13h10l1-13M10 11v6M14 11v6' />
    </svg>
  )
}
