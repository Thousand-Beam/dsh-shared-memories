/**
 * dsh-shared-memories — 记忆总览（client/memory-list.tsx）
 * ---------------------------------------------------------------------------
 * 结构：筛选工具条 → 胶囊筛选区 → 记忆卡片流。
 *
 * 筛选策略刻意做成"客户端即时筛选"：`state.ts` 的 `filterMemories` 是纯函数，
 * 点一下胶囊立刻出结果，不用等一次 HTTP 往返。唯一例外是**跨 Agent 全局检索**——
 * 它必须回服务端取（要走审计与 globalToken），所以它单独走一次 `api.memories`。
 */

import { useState, type ReactNode } from 'react'
import type { MemoryCard } from '../shared/console-api.js'
import { api } from './api.js'
import { filterMemories, useConsole, useStore } from './state.js'
import { EMOTION_ORDER, KIND_ORDER, distillLabel, emotionLabel, kindLabel, statusLabel } from './i18n.js'
import { agentLabel, formatDateTime, shortCode, shortId, trustLevel } from './format.js'
import { CardSkeleton, EmotionChip, EmptyState, Modal, Pill, SearchIcon, Stat, StatusDot, Tag, TrustBar } from './ui.js'

/* ── 配色 --- 只用来给胶囊小圆点上色，真正的颜色定义在 styles.ts ────────── */

const EMOTION_DOT: Record<string, string> = {
  joy: 'var(--dsm-joy)',
  anxiety: 'var(--dsm-anxiety)',
  frustration: 'var(--dsm-frustration)',
  pride: 'var(--dsm-pride)',
  curiosity: 'var(--dsm-curiosity)',
  anger: 'var(--dsm-anger)',
  sadness: 'var(--dsm-sadness)',
  neutral: 'var(--dsm-neutral)',
}

const STATUS_TONE: Record<MemoryCard['status'], 'ok' | 'warn' | 'danger' | 'idle' | 'accent'> = {
  active: 'ok',
  merged: 'accent',
  quarantined: 'danger',
  forgotten: 'idle',
}

const STATUS_DOT: Record<MemoryCard['status'], 'ok' | 'warn' | 'danger' | 'idle'> = {
  active: 'ok',
  merged: 'idle',
  quarantined: 'danger',
  forgotten: 'idle',
}

/* ── 主体 ─────────────────────────────────────────────────────────────── */

export function MemoryView(): ReactNode {
  const store = useStore()
  const state = useConsole((snapshot) => snapshot)
  const [editing, setEditing] = useState<MemoryCard | null>(null)

  const visible = filterMemories(state)
  const total = state.memories.length
  const filtering =
    state.filters.kinds.length > 0 ||
    state.filters.emotions.length > 0 ||
    state.filters.query.trim() !== '' ||
    state.filters.trustMin > 0

  /** 来源一律显示人名；查不到（跨 Agent 检索时对方未注册）就退回 4 位代号。 */
  const agentName = (agentId: string): string => {
    const found = state.agents.find((agent) => agent.agentId === agentId)
    if (found !== undefined) return agentLabel(found)
    return `Agent · ${shortCode(agentId, 4)}`
  }

  /** 类型/情感胶囊的候选集合：字典里有的一律列出（保证界面不出现英文枚举），
   *  但只把"当前 Agent 真的有数据"的排前面，避免一排永远点不出结果的死胶囊。 */
  const kindOptions = KIND_ORDER
  const emotionOptions = EMOTION_ORDER

  const toggleGlobal = async (): Promise<void> => {
    const next = !state.filters.global
    store.setFilters({ global: next })
    try {
      const rows = await api.memories({ agentId: state.activeAgentId, global: next })
      store.patch({ memories: rows })
      store.toast('ok', next ? '已切换到跨 Agent 全局检索（本次有审计记录）' : '已回到当前 Agent 的记忆')
    } catch (cause) {
      store.setFilters({ global: !next })
      store.toast('error', cause instanceof Error ? cause.message : '切换检索范围失败')
    }
  }

  const reload = async (): Promise<void> => {
    try {
      const rows = await api.memories({ agentId: state.activeAgentId, global: state.filters.global })
      store.patch({ memories: rows })
    } catch (cause) {
      store.toast('error', cause instanceof Error ? cause.message : '重载记忆失败')
    }
  }

  return (
    <div className='dsm-page'>
      {/* 工具条 */}
      <div className='dsm-card dsm-card--flat'>
        <div className='dsm-row dsm-row--wrap' style={{ gap: 10 }}>
          <div className='dsm-search'>
            <span className='dsm-search-icon'>
              <SearchIcon />
            </span>
            <input
              className='dsm-input'
              placeholder='搜索记忆正文或主题键…'
              value={state.filters.query}
              onChange={(event) => store.setFilters({ query: event.target.value })}
            />
          </div>
          <Pill
            label={state.filters.global ? '全局检索：开' : '仅当前 Agent'}
            active={state.filters.global}
            onClick={() => {
              void toggleGlobal()
            }}
            quiet
            title='跨 Agent 检索会写入审计记录'
          />
        </div>

        <div className='dsm-row dsm-row--wrap' style={{ gap: 14, marginTop: 12 }}>
          <div className='dsm-col' style={{ gap: 4, flex: '1 1 220px' }}>
            <span className='dsm-field-label'>
              最低信任度 <span className='dsm-num'>{state.filters.trustMin.toFixed(2)}</span>
            </span>
            <input
              className='dsm-range'
              type='range'
              min={0}
              max={1}
              step={0.05}
              value={state.filters.trustMin}
              onChange={(event) => store.setFilters({ trustMin: Number(event.target.value) })}
            />
          </div>
          <div className='dsm-stats'>
            <Stat value={<span className='dsm-num'>{total}</span>} label='已载入' />
            <Stat value={<span className='dsm-num'>{visible.length}</span>} label='符合筛选' />
          </div>
        </div>
      </div>

      {/* 胶囊筛选 */}
      <div className='dsm-card dsm-card--flat dsm-stack' style={{ gap: 12 }}>
        <div className='dsm-filter-block'>
          <span className='dsm-filter-label'>记忆类型</span>
          <div className='dsm-pill-row'>
            {kindOptions.map((kind) => (
              <Pill
                key={kind}
                label={kindLabel(kind)}
                active={state.filters.kinds.includes(kind)}
                onClick={() => store.toggleFilterValue('kinds', kind)}
              />
            ))}
          </div>
        </div>
        <div className='dsm-filter-block'>
          <span className='dsm-filter-label'>情感色彩</span>
          <div className='dsm-pill-row'>
            {emotionOptions.map((emotion) => (
              <Pill
                key={emotion}
                label={emotionLabel(emotion)}
                dot={EMOTION_DOT[emotion] ?? 'var(--dsm-neutral)'}
                active={state.filters.emotions.includes(emotion)}
                onClick={() => store.toggleFilterValue('emotions', emotion)}
              />
            ))}
          </div>
        </div>
        {filtering ? (
          <div className='dsm-row dsm-row--wrap' style={{ gap: 8 }}>
            <span className='dsm-caption'>正在按 {visible.length} / {total} 条展示</span>
            <span className='dsm-spacer' />
            <button
              type='button'
              className='dsm-btn dsm-btn--sm dsm-btn--ghost'
              onClick={() =>
                store.setFilters({ kinds: [], emotions: [], query: '', trustMin: 0 })
              }
            >
              清除筛选
            </button>
          </div>
        ) : null}
      </div>

      {/* 列表 */}
      {state.status === 'loading' && total === 0 ? (
        <div className='dsm-stack'>
          <CardSkeleton rows={3} />
          <CardSkeleton rows={4} />
          <CardSkeleton rows={2} />
        </div>
      ) : visible.length === 0 ? (
        total === 0 ? (
          <EmptyState
            icon='🫧'
            title='这个 Agent 还没有任何记忆'
            hint='当它完成一次会话、或者你手动保存一次之后，条目会出现在这里。'
          />
        ) : (
          <EmptyState
            icon='🔍'
            title='没有符合当前筛选的记忆'
            hint='把类型或情感胶囊放开一点，或者把最低信任度调低。'
            action={{ label: '清除筛选', onClick: () => store.setFilters({ kinds: [], emotions: [], query: '', trustMin: 0 }) }}
          />
        )
      ) : (
        <div className='dsm-stack'>
          {visible.map((memory) => (
            <MemoryCardView
              key={memory.versionId}
              memory={memory}
              agentName={agentName(memory.agentId)}
              onEditEmotion={() => setEditing(memory)}
            />
          ))}
        </div>
      )}

      {editing === null ? null : (
        <EmotionDialog
          memory={editing}
          onClose={() => setEditing(null)}
          onSaved={async () => {
            setEditing(null)
            await reload()
            store.toast('ok', '情感标签已修正')
          }}
        />
      )}
    </div>
  )
}

/* ── 单条记忆卡片 ─────────────────────────────────────────────────────── */

function MemoryCardView(props: {
  memory: MemoryCard
  agentName: string
  onEditEmotion: () => void
}): ReactNode {
  const { memory } = props
  const trust = trustLevel(memory.trust)
  const emotion = memory.emotion

  return (
    <article className='dsm-card'>
      {/* 顶部：状态 + 类型 + 信任度 */}
      <div className='dsm-card-head'>
        <StatusDot tone={STATUS_DOT[memory.status]} />
        <Tag tone={STATUS_TONE[memory.status]}>{statusLabel(memory.status)}</Tag>
        <Tag tone='outline'>{kindLabel(memory.kind)}</Tag>
        {memory.distillStatus === 'raw' ? null : (
          <Tag tone={memory.distillStatus === 'failed' ? 'warn' : 'idle'}>{distillLabel(memory.distillStatus)}</Tag>
        )}
        <span className='dsm-spacer' />
        <TrustBar value={memory.trust} tone={trust.tone} label={`信任度 ${trust.label}`} />
      </div>

      {/* 中部：正文 */}
      <div className='dsm-card-body'>{memory.text}</div>

      {/* 底部：情感 + 来源 */}
      <div className='dsm-card-foot'>
        {emotion === null ? (
          <EmotionChip
            label='neutral'
            placeholder
            onClick={props.onEditEmotion}
            title='点击标注情感'
          />
        ) : (
          <EmotionChip
            label={emotion.label}
            text={emotionLabel(emotion.label)}
            intensity={emotion.intensity}
            onClick={props.onEditEmotion}
            title={`${emotionLabel(emotion.label)}｜对象：${emotion.subject}｜触发：${emotion.trigger}`}
          />
        )}
        <span className='dsm-muted'>来源 {props.agentName}</span>
        <span className='dsm-mono' title={memory.subjectKey}>
          {memory.subjectKey}
        </span>
        <span className='dsm-spacer' />
        <span className='dsm-caption' title={`版本 ${memory.versionId}`}>
          {formatDateTime(memory.validFrom)} · {shortId(memory.versionId)}
        </span>
      </div>
    </article>
  )
}

/* ── 情感修正弹层 ─────────────────────────────────────────────────────── */

const INTENSITY_STEPS = [0.2, 0.4, 0.6, 0.8, 1] as const

function EmotionDialog(props: {
  memory: MemoryCard
  onClose: () => void
  onSaved: () => Promise<void>
}): ReactNode {
  const emotion = props.memory.emotion
  const [label, setLabel] = useState<string>(emotion?.label ?? 'neutral')
  const [subject, setSubject] = useState<string>(emotion?.subject ?? '')
  const [trigger, setTrigger] = useState<string>(emotion?.trigger ?? '')
  const [intensity, setIntensity] = useState<number>(emotion?.intensity ?? 0.6)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const save = async (): Promise<void> => {
    setBusy(true)
    setError(null)
    try {
      await api.fixEmotion({
        versionId: props.memory.versionId,
        label,
        subject: subject.trim() === '' ? undefined : subject.trim(),
        trigger: trigger.trim() === '' ? undefined : trigger.trim(),
        intensity,
      })
      await props.onSaved()
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '修正失败')
    } finally {
      setBusy(false)
    }
  }

  return (
    <Modal
      title='修正情感归因'
      onClose={props.onClose}
      actions={
        <>
          <button type='button' className='dsm-btn dsm-btn--ghost' onClick={props.onClose} disabled={busy}>
            取消
          </button>
          <button
            type='button'
            className='dsm-btn dsm-btn--primary'
            onClick={() => {
              void save()
            }}
            disabled={busy}
          >
            {busy ? '保存中…' : '保存'}
          </button>
        </>
      }
    >
      <div className='dsm-stack' style={{ gap: 12 }}>
        <div className='dsm-quote'>{props.memory.text}</div>

        <div className='dsm-filter-block'>
          <span className='dsm-field-label'>情感标签</span>
          <div className='dsm-pill-row'>
            {EMOTION_ORDER.map((option) => (
              <Pill
                key={option}
                label={emotionLabel(option)}
                dot={EMOTION_DOT[option] ?? 'var(--dsm-neutral)'}
                active={label === option}
                onClick={() => setLabel(option)}
              />
            ))}
          </div>
        </div>

        <div className='dsm-form-grid'>
          <label className='dsm-field'>
            <span className='dsm-field-label'>情感对象（谁/什么引起的）</span>
            <input className='dsm-input dsm-input--sm' value={subject} onChange={(event) => setSubject(event.target.value)} placeholder='例如：用户、某个报错' />
          </label>
          <label className='dsm-field'>
            <span className='dsm-field-label'>触发事件</span>
            <input className='dsm-input dsm-input--sm' value={trigger} onChange={(event) => setTrigger(event.target.value)} placeholder='例如：构建失败' />
          </label>
        </div>

        <div className='dsm-field'>
          <span className='dsm-field-label'>强度 {Math.round(intensity * 100)}%</span>
          <div className='dsm-pill-row'>
            {INTENSITY_STEPS.map((step) => (
              <Pill key={step} label={`${Math.round(step * 100)}%`} active={Math.abs(intensity - step) < 0.05} onClick={() => setIntensity(step)} />
            ))}
          </div>
          <input
            className='dsm-range'
            type='range'
            min={0}
            max={1}
            step={0.05}
            value={intensity}
            onChange={(event) => setIntensity(Number(event.target.value))}
          />
        </div>

        {error === null ? null : <Tag tone='danger'>{error}</Tag>}

        <p className='dsm-caption'>
          修正会写入一条新的记忆版本，旧版本进时间树，不会被直接覆盖。
        </p>
      </div>
    </Modal>
  )
}
