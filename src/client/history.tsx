/**
 * dsh-shared-memories — 快照时间轴（client/history.tsx）
 * ---------------------------------------------------------------------------
 * 视觉核心是那条**垂直连线**：`.dsm-timeline::before` 画线，`.dsm-node::before`
 * 画节点圆点（钉住的节点外圈多一层光晕、最新节点放大 1.25），
 * 所以这里只管数据顺序，不要再自己拼 border-left，否则线会画两遍。
 *
 * 顺序：新 → 旧（createdAt 倒序）。回退有二次确认，因为它是**破坏性**操作：
 * 会把当前工作区拉到历史节点上，之后的改动只能靠再回退找回。
 */

import { useState, type ReactNode } from 'react'
import type { SnapshotNode } from '../shared/console-api.js'
import { api } from './api.js'
import { useConsole, useStore } from './state.js'
import { triggerLabel } from './i18n.js'
import { formatBytes, formatDateTime, formatRelative, shortId } from './format.js'
import { CardSkeleton, EmptyState, Modal, Stat, Tag } from './ui.js'

const TRIGGER_TONE: Record<SnapshotNode['trigger'], 'accent' | 'ok' | 'warn' | 'danger' | 'idle'> = {
  manual: 'accent',
  shutdown: 'ok',
  interval: 'idle',
  idle: 'idle',
  'pre-rollback': 'warn',
}

const TRIGGERS: ReadonlyArray<SnapshotNode['trigger']> = ['manual', 'shutdown', 'interval', 'idle', 'pre-rollback']

/** 触发方式 → 节点颜色（CSS 变量），时间轴圆点与图例共用同一套，避免两处色差。 */
function triggerColor(trigger: SnapshotNode['trigger']): string {
  const tone = TRIGGER_TONE[trigger]
  return tone === 'idle' ? 'var(--dsm-idle)' : `var(--dsm-${tone})`
}

export function HistoryView(): ReactNode {
  const store = useStore()
  const state = useConsole((snapshot) => snapshot)
  const [pendingRollback, setPendingRollback] = useState<SnapshotNode | null>(null)
  const [busy, setBusy] = useState(false)

  const nodes = [...state.snapshots].sort((left, right) => right.createdAt - left.createdAt)
  const pinned = nodes.filter((node) => node.pinned).length
  const totalBytes = nodes.reduce((sum, node) => sum + node.bytes, 0)

  const refresh = async (): Promise<void> => {
    const [snapshots, memories] = await Promise.all([
      api.snapshots(state.activeAgentId),
      api.memories({ agentId: state.activeAgentId, global: state.filters.global }),
    ])
    store.patch({ snapshots, memories })
  }

  const togglePin = async (node: SnapshotNode): Promise<void> => {
    const next = !node.pinned
    try {
      await api.pin(node.snapshotId, next)
      // 接口只回单个节点的钉住状态，列表仍以服务端为准重拉一次，避免本地拼状态漂移。
      const rows = await api.snapshots(state.activeAgentId)
      store.patch({ snapshots: rows })
      store.toast('ok', next ? '已钉住，轮转时不会清理' : '已取消钉住')
    } catch (cause) {
      store.toast('error', cause instanceof Error ? cause.message : '钉住失败')
    }
  }

  const doRollback = async (node: SnapshotNode): Promise<void> => {
    setBusy(true)
    try {
      await api.rollback(node.snapshotId)
      setPendingRollback(null)
      await refresh()
      store.toast('ok', `已回退到 ${shortId(node.snapshotId)}`)
    } catch (cause) {
      store.toast('error', cause instanceof Error ? cause.message : '回退失败')
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className='dsm-page'>
      <div className='dsm-card dsm-card--flat'>
        <div className='dsm-row dsm-row--wrap' style={{ gap: 10 }}>
          <span className='dsm-h2'>快照池</span>
          <Tag tone='outline'>保留 {state.snapshotKeep} 个 · 已钉住 {pinned}</Tag>
          <span className='dsm-spacer' />
          <Stat value={<span className='dsm-num'>{nodes.length}</span>} label='节点' />
          <Stat value={formatBytes(totalBytes)} label='占用' />
        </div>
        <div className='dsm-legend' style={{ marginTop: 10 }}>
          {TRIGGERS.map((trigger) => (
            <span className='dsm-legend-item' key={trigger}>
              <span className='dsm-legend-swatch' style={{ background: triggerColor(trigger) }} />
              {triggerLabel(trigger)}
            </span>
          ))}
        </div>
      </div>

      {state.status === 'loading' && nodes.length === 0 ? (
        <div className='dsm-stack'>
          <CardSkeleton rows={2} />
          <CardSkeleton rows={2} />
        </div>
      ) : nodes.length === 0 ? (
        <EmptyState
          icon='🕒'
          title='还没有任何快照'
          hint='手动保存一次，或者等它空闲/关机时自动落盘，这里就会出现第一个节点。'
        />
      ) : (
        <div className='dsm-timeline'>
          {nodes.map((node, index) => (
            <div
              className='dsm-node'
              key={node.snapshotId}
              data-latest={index === 0}
              data-pinned={node.pinned}
              style={{ ['--dsm-node-color' as string]: triggerColor(node.trigger) }}
            >
              <div className='dsm-card dsm-node-card'>
                <div className='dsm-node-meta'>
                  <Tag tone={TRIGGER_TONE[node.trigger]}>{triggerLabel(node.trigger)}</Tag>
                  <span className='dsm-num' title={formatDateTime(node.createdAt)}>
                    {formatRelative(node.createdAt)}
                  </span>
                  <span className='dsm-muted'>{node.device}</span>
                  {node.pinned ? <Tag tone='ok'>已钉住</Tag> : null}
                  <span className='dsm-spacer' />
                </div>

                <div className='dsm-node-summary'>{node.summary}</div>

                <div className='dsm-node-meta' style={{ marginTop: 8 }}>
                  <span className='dsm-mono dsm-muted' title={node.snapshotId}>
                    {shortId(node.snapshotId)}
                  </span>
                  <span className='dsm-muted'>·</span>
                  <span className='dsm-num'>{node.files} 个文件</span>
                  <span className='dsm-muted'>·</span>
                  <span className='dsm-num'>{formatBytes(node.bytes)}</span>
                  {node.commit === undefined || node.commit === null || node.commit === '' ? null : (
                    <>
                      <span className='dsm-muted'>·</span>
                      <span className='dsm-mono'>{shortId(node.commit)}</span>
                    </>
                  )}
                  {node.tag === undefined || node.tag === null || node.tag === '' ? null : (
                    <>
                      <span className='dsm-muted'>·</span>
                      <Tag tone='outline'>{node.tag}</Tag>
                    </>
                  )}
                  <span className='dsm-spacer' />
                  <button
                    type='button'
                    className='dsm-btn dsm-btn--sm dsm-btn--ghost'
                    onClick={() => {
                      void togglePin(node)
                    }}
                  >
                    {node.pinned ? '取消钉住' : '钉住'}
                  </button>
                  <button
                    type='button'
                    className='dsm-btn dsm-btn--sm'
                    onClick={() => setPendingRollback(node)}
                    disabled={index === 0}
                    title={index === 0 ? '已经是最新节点' : '把工作区回退到这个节点'}
                  >
                    回退到此
                  </button>
                </div>
              </div>
            </div>
          ))}
        </div>
      )}

      {pendingRollback === null ? null : (
        <Modal
          title='确认回退'
          onClose={() => {
            if (!busy) setPendingRollback(null)
          }}
          actions={
            <>
              <button type='button' className='dsm-btn dsm-btn--ghost' onClick={() => setPendingRollback(null)} disabled={busy}>
                取消
              </button>
              <button
                type='button'
                className='dsm-btn dsm-btn--primary'
                onClick={() => {
                  void doRollback(pendingRollback)
                }}
                disabled={busy}
              >
                {busy ? '回退中…' : '确认回退'}
              </button>
            </>
          }
        >
          <div className='dsm-stack' style={{ gap: 10 }}>
            <p>
              工作区会被拉到 <span className='dsm-mono'>{shortId(pendingRollback.snapshotId)}</span>
              （{formatDateTime(pendingRollback.createdAt)}）的状态。回退前会先自动打一个
              “回退前保护”节点，所以这一步不会丢东西。
            </p>
            <div className='dsm-quote'>{pendingRollback.summary}</div>
          </div>
        </Modal>
      )}
    </div>
  )
}
