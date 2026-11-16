/**
 * dsh-shared-memories — 规则与人格（client/rules.tsx）
 * ---------------------------------------------------------------------------
 * 一块页面装三件事：
 *   ① 人格档案（名字 / 心理年龄 / 性格倾向 traits）——可编辑，右侧实时预览
 *      注入给模型的那段 Markdown，避免"改完不知道注进去了什么"；
 *   ② 经验条目（现象 → 经验 → 模式 → 规则 四阶），可逐级升格；
 *   ③ 待确认的升格请求——有有效期，过期自动作废，所以带倒计时。
 *
 * 落锁（baseline）是**不可逆的确认动作**：要把 agentId 原样敲一遍才允许写，
 * 因为一旦落锁，之后的人格漂移就会被判为"越线"，这是插件最重要的那道闸。
 */

import { useEffect, useState, type ReactNode } from 'react'
import type { PersonaDoc, PromotionPreview, RuleItem, RuleStage } from '../shared/console-api.js'
import { api } from './api.js'
import { useConsole, useStore } from './state.js'
import { stageLabel, traitLabel } from './i18n.js'
import { agentLabel, formatDateTime, formatRelative, shortCode } from './format.js'
import { CardSkeleton, EmptyState, Modal, Pill, Stat, Tag } from './ui.js'

const STAGES: ReadonlyArray<RuleStage> = ['observation', 'lesson', 'pattern', 'rule']

const STAGE_TONE: Record<RuleStage, 'idle' | 'accent' | 'ok' | 'warn'> = {
  observation: 'idle',
  lesson: 'accent',
  pattern: 'ok',
  rule: 'warn',
}

function nextStage(stage: RuleStage): RuleStage | null {
  const index = STAGES.indexOf(stage)
  const next = index < 0 ? undefined : STAGES[index + 1]
  return next ?? null
}

function previousStage(stage: RuleStage): RuleStage {
  const index = STAGES.indexOf(stage)
  const previous = index <= 0 ? undefined : STAGES[index - 1]
  return previous ?? 'observation'
}

function describe(cause: unknown, fallback: string): string {
  return cause instanceof Error && cause.message !== '' ? cause.message : fallback
}

/* ── 主体 ─────────────────────────────────────────────────────────────── */

export function RulesView(): ReactNode {
  const store = useStore()
  const state = useConsole((snapshot) => snapshot)
  const agentId = state.activeAgentId

  const [persona, setPersona] = useState<PersonaDoc | null>(null)
  const [items, setItems] = useState<RuleItem[]>([])
  const [pending, setPending] = useState<PromotionPreview[]>([])
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [lockOpen, setLockOpen] = useState(false)
  /** 命中字典的性格键默认显示中文；点了“改键名”才露出原始 key 的输入框。 */
  const [editingKey, setEditingKey] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    setLoading(true)
    void (async () => {
      try {
        const [doc, bundle] = await Promise.all([api.persona(agentId), api.rules(agentId)])
        if (cancelled) return
        setPersona(doc)
        setItems(bundle.items)
        setPending(bundle.pending)
      } catch (cause) {
        if (!cancelled) store.toast('error', describe(cause, '载入人格与规则失败'))
      } finally {
        if (!cancelled) setLoading(false)
      }
    })()
    return () => {
      cancelled = true
    }
  }, [agentId, store])

  const reloadRules = async (): Promise<void> => {
    const bundle = await api.rules(agentId)
    setItems(bundle.items)
    setPending(bundle.pending)
  }

  const savePersona = async (withBaseline: boolean): Promise<void> => {
    if (persona === null) return
    setSaving(true)
    try {
      const saved = await api.savePersona({
        agentId: persona.agentId,
        name: persona.name,
        age: persona.age,
        traits: persona.traits,
        ...(withBaseline ? { baselineHash: persona.baselineHash } : {}),
      })
      setPersona(saved)
      setLockOpen(false)
      store.toast('ok', withBaseline ? '人格已确认写入并落锁' : '人格已保存')
    } catch (cause) {
      store.toast('error', describe(cause, '保存人格失败'))
    } finally {
      setSaving(false)
    }
  }

  const promote = async (item: RuleItem): Promise<void> => {
    const to = nextStage(item.stage)
    if (to === null) return
    try {
      const preview = await api.promote({ agentId, pitfallId: item.pitfallId, to })
      setPending((rows) => [preview, ...rows])
      store.toast('ok', `已生成升格请求：${stageLabel(item.stage)} → ${stageLabel(to)}`)
    } catch (cause) {
      store.toast('error', describe(cause, '生成升格请求失败'))
    }
  }

  const confirm = async (request: PromotionPreview): Promise<void> => {
    try {
      await api.confirmPromotion({ agentId, requestId: request.requestId, by: 'user' })
      setPending((rows) => rows.filter((row) => row.requestId !== request.requestId))
      await reloadRules()
      store.toast('ok', `已升格到「${stageLabel(request.to)}」`)
    } catch (cause) {
      store.toast('error', describe(cause, '确认升格失败'))
    }
  }

  const reject = async (request: PromotionPreview): Promise<void> => {
    try {
      await api.rejectPromotion(request.requestId)
      setPending((rows) => rows.filter((row) => row.requestId !== request.requestId))
      store.toast('ok', '已放弃这次升格')
    } catch (cause) {
      store.toast('error', describe(cause, '放弃升格失败'))
    }
  }

  if (loading && persona === null) {
    return (
      <div className='dsm-page'>
        <CardSkeleton rows={3} />
        <CardSkeleton rows={4} />
      </div>
    )
  }

  if (persona === null) {
    return (
      <div className='dsm-page'>
        <EmptyState icon='🧬' title='还没读到人格档案' hint='切换一个 Agent，或者确认宿主侧的人格服务已经挂载。' />
      </div>
    )
  }

  const confirmedItems = items.filter((item) => item.stage === 'rule' || item.confirmed)

  return (
    <div className='dsm-page'>
      {/* 人格档案 */}
      <div className='dsm-card'>
        <div className='dsm-card-head'>
          <span className='dsm-h2'>人格档案</span>
          <Tag tone='outline' title={`基线指纹：${persona.baselineHash}`}>
            底线已落锁 · {persona.baselineHash.slice(0, 12)}
          </Tag>
          <span className='dsm-spacer' />
          <span className='dsm-caption'>更新于 {formatRelative(persona.updatedAt)}</span>
        </div>

        <div className='dsm-split' style={{ marginTop: 12 }}>
          {/* 左：编辑 */}
          <div className='dsm-stack' style={{ gap: 12 }}>
            <div className='dsm-form-grid'>
              <label className='dsm-field'>
                <span className='dsm-field-label'>名字</span>
                <input
                  className='dsm-input dsm-input--sm'
                  value={persona.name}
                  onChange={(event) => setPersona({ ...persona, name: event.target.value })}
                />
              </label>
              <label className='dsm-field'>
                <span className='dsm-field-label' title='内部字段 age：人格演化的基线刻度，不在卡片上展示'>
                  成长刻度
                </span>
                <input
                  className='dsm-input dsm-input--sm dsm-num'
                  type='number'
                  min={1}
                  max={99}
                  value={persona.age}
                  onChange={(event) => setPersona({ ...persona, age: Number(event.target.value) })}
                />
              </label>
            </div>

            <div className='dsm-filter-block'>
              <span className='dsm-filter-label'>性格倾向</span>
              <div className='dsm-stack' style={{ gap: 8 }}>
                {Object.entries(persona.traits).map(([key, value]) => (
                  <div className='dsm-row' key={key} style={{ gap: 8 }}>
                    {editingKey === key ? (
                      <input
                        className='dsm-input dsm-input--sm'
                        style={{ width: 108 }}
                        autoFocus
                        value={key}
                        onChange={(event) => {
                          const renamed = event.target.value
                          setEditingKey(renamed)
                          setPersona((current) => {
                            if (current === null) return current
                            const next: Record<string, number> = {}
                            for (const [traitKey, traitValue] of Object.entries(current.traits)) {
                              next[traitKey === key ? renamed : traitKey] = traitValue
                            }
                            return { ...current, traits: next }
                          })
                        }}
                        onBlur={() => setEditingKey(null)}
                      />
                    ) : (
                      <button
                        type='button'
                        className='dsm-tag dsm-tag--outline'
                        style={{ width: 108, justifyContent: 'space-between' }}
                        title={`改键名（当前：${key}）`}
                        onClick={() => setEditingKey(key)}
                      >
                        <span className='dsm-truncate'>{traitLabel(key)}</span>
                        <span aria-hidden='true' style={{ opacity: 0.45 }}>✎</span>
                      </button>
                    )}
                    <input
                      className='dsm-range'
                      style={{ flex: '1 1 auto' }}
                      type='range'
                      min={0}
                      max={1}
                      step={0.05}
                      value={value}
                      onChange={(event) => {
                        const nextValue = Number(event.target.value)
                        setPersona((current) =>
                          current === null ? current : { ...current, traits: { ...current.traits, [key]: nextValue } },
                        )
                      }}
                    />
                    <span className='dsm-caption dsm-num' style={{ width: 34, textAlign: 'right' }}>
                      {value.toFixed(2)}
                    </span>
                    <button
                      type='button'
                      className='dsm-btn dsm-btn--sm dsm-btn--ghost'
                      onClick={() =>
                        setPersona((current) => {
                          if (current === null) return current
                          const next = { ...current.traits }
                          delete next[key]
                          return { ...current, traits: next }
                        })
                      }
                      title='删除这一项'
                    >
                      ✕
                    </button>
                  </div>
                ))}
              </div>
              <button
                type='button'
                className='dsm-btn dsm-btn--sm'
                style={{ alignSelf: 'flex-start' }}
                onClick={() =>
                  setPersona((current) => {
                    if (current === null) return current
                    const next = { ...current.traits, [`trait${Object.keys(current.traits).length + 1}`]: 0.5 }
                    return { ...current, traits: next }
                  })
                }
              >
                + 新增倾向
              </button>
            </div>

            <div className='dsm-row' style={{ gap: 8 }}>
              <button
                type='button'
                className='dsm-btn dsm-btn--primary'
                onClick={() => {
                  void savePersona(false)
                }}
                disabled={saving}
              >
                {saving ? '保存中…' : '保存人格'}
              </button>
              <button type='button' className='dsm-btn' onClick={() => setLockOpen(true)} disabled={saving}>
                确认写入并落锁
              </button>
            </div>
          </div>

          {/* 右：注入预览 */}
          <div className='dsm-col' style={{ gap: 6 }}>
            <span className='dsm-caption'>即将注入给模型的系统提示片段</span>
            <pre className='dsm-pre dsm-scroll-y'>{renderPersonaMarkdown(persona, confirmedItems)}</pre>
          </div>
        </div>
      </div>

      {/* 待确认升格 */}
      {pending.length === 0 ? null : (
        <div className='dsm-stack'>
          <div className='dsm-row'>
            <span className='dsm-h2'>待确认的升格</span>
            <Tag tone='warn'>{pending.length}</Tag>
          </div>
          {pending.map((request) => (
            <PendingCard
              key={request.requestId}
              request={request}
              onConfirm={() => {
                void confirm(request)
              }}
              onReject={() => {
                void reject(request)
              }}
            />
          ))}
        </div>
      )}

      {/* 经验条目 */}
      <div className='dsm-row' style={{ gap: 8 }}>
        <span className='dsm-h2'>经验条目</span>
        <Tag tone='outline'>{items.length}</Tag>
        <span className='dsm-spacer' />
        <span className='dsm-caption'>现象 → 经验 → 模式 → 规则，逐级升格</span>
      </div>

      {items.length === 0 ? (
        <EmptyState icon='🌱' title='还没有沉淀下来的经验' hint='踩坑、纠正、被否定的做法都会先落到「现象」，攒够了再往上走。' />
      ) : (
        <div className='dsm-stack'>
          {items.map((item) => (
            <RuleCard
              key={item.pitfallId}
              item={item}
              onPromote={() => {
                void promote(item)
              }}
            />
          ))}
        </div>
      )}

      {lockOpen ? (
        <ConfirmPersonaDialog
          persona={persona}
          busy={saving}
          onClose={() => setLockOpen(false)}
          onConfirm={() => {
            void savePersona(true)
          }}
        />
      ) : null}

      <div className='dsm-card dsm-card--flat'>
        <div className='dsm-row dsm-row--wrap' style={{ gap: 12 }}>
          <span className='dsm-h3'>阶段分布</span>
          {STAGES.map((stage) => (
            <Stat key={stage} value={<span className='dsm-num'>{items.filter((item) => item.stage === stage).length}</span>} label={stageLabel(stage)} />
          ))}
        </div>
      </div>
    </div>
  )
}

/* ── 单条经验 ─────────────────────────────────────────────────────────── */

function RuleCard(props: { item: RuleItem; onPromote: () => void }): ReactNode {
  const { item } = props
  const to = nextStage(item.stage)
  return (
    <article className='dsm-card'>
      <div className='dsm-card-head'>
        <Tag tone={STAGE_TONE[item.stage]}>{stageLabel(item.stage)}</Tag>
        {item.confirmed ? <Tag tone='ok'>已确认</Tag> : null}
        <Tag tone='idle'>出现 {item.occurrences} 次</Tag>
        <span className='dsm-spacer' />
        <span className='dsm-caption'>{formatDateTime(item.updatedAt)}</span>
      </div>

      <div className='dsm-card-body'>{item.observation}</div>

      <div className='dsm-stack' style={{ gap: 6, marginTop: 10 }}>
        {item.lesson === '' ? null : <FieldLine label='经验' text={item.lesson} />}
        {item.pattern === '' ? null : <FieldLine label='模式' text={item.pattern} />}
        {item.rule === '' ? null : <FieldLine label='规则' text={item.rule} />}
      </div>

      <div className='dsm-card-foot'>
        <span className='dsm-caption dsm-mono' title={`踩坑记录 ${item.pitfallId}`}>
          #{shortCode(item.pitfallId)}
        </span>
        <span className='dsm-spacer' />
        {to === null ? (
          <span className='dsm-caption'>已经是最高阶</span>
        ) : (
          <button type='button' className='dsm-btn dsm-btn--sm' onClick={props.onPromote}>
            升格为「{stageLabel(to)}」
          </button>
        )}
      </div>
    </article>
  )
}

function FieldLine(props: { label: string; text: string }): ReactNode {
  return (
    <div className='dsm-row' style={{ alignItems: 'flex-start', gap: 8 }}>
      <span className='dsm-tag dsm-tag--outline' style={{ flex: '0 0 auto' }}>
        {props.label}
      </span>
      <span style={{ fontSize: 12.5, lineHeight: 1.7 }}>{props.text}</span>
    </div>
  )
}

/* ── 待确认升格卡 ─────────────────────────────────────────────────────── */

function PendingCard(props: {
  request: PromotionPreview
  onConfirm: () => void
  onReject: () => void
}): ReactNode {
  const { request } = props
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 1000)
    return () => window.clearInterval(timer)
  }, [])
  const left = Math.max(0, Math.round((request.expiresAt - now) / 1000))

  return (
    <article className='dsm-card dsm-card--accent'>
      <div className='dsm-card-head'>
        <Tag tone='warn'>待确认</Tag>
        <span className='dsm-h3'>
          {stageLabel(previousStage(request.to))} → {stageLabel(request.to)}
        </span>
        <span className='dsm-spacer' />
        <span className='dsm-caption dsm-num'>{left}s 后失效</span>
      </div>
      <div className='dsm-stack' style={{ gap: 6, marginTop: 10 }}>
        <FieldLine label='现象' text={request.preview.observation} />
        {request.preview.lesson === '' ? null : <FieldLine label='经验' text={request.preview.lesson} />}
        {request.preview.pattern === '' ? null : <FieldLine label='模式' text={request.preview.pattern} />}
        {request.preview.rule === '' ? null : <FieldLine label='规则' text={request.preview.rule} />}
      </div>
      <div className='dsm-card-foot'>
        <span className='dsm-spacer' />
        <button type='button' className='dsm-btn dsm-btn--sm dsm-btn--ghost' onClick={props.onReject}>
          放弃
        </button>
        <button type='button' className='dsm-btn dsm-btn--sm dsm-btn--primary' onClick={props.onConfirm}>
          确认写入
        </button>
      </div>
    </article>
  )
}

/* ── 落锁确认 ─────────────────────────────────────────────────────────── */

function ConfirmPersonaDialog(props: {
  persona: PersonaDoc
  busy: boolean
  onClose: () => void
  onConfirm: () => void
}): ReactNode {
  const [typed, setTyped] = useState('')
  /** 让人敲的是**名字**，不是 36 位 uuid —— 名字为空时才退回代号。 */
  const expected = agentLabel(props.persona).trim()
  const ok = typed.trim() === expected

  return (
    <Modal
      title='确认写入并落锁'
      onClose={props.onClose}
      actions={
        <>
          <button type='button' className='dsm-btn dsm-btn--ghost' onClick={props.onClose} disabled={props.busy}>
            取消
          </button>
          <button type='button' className='dsm-btn dsm-btn--primary' onClick={props.onConfirm} disabled={!ok || props.busy}>
            {props.busy ? '写入中…' : '确认写入'}
          </button>
        </>
      }
    >
      <div className='dsm-stack' style={{ gap: 10 }}>
        <p>
          写入后这份人格会成为该 Agent 的<strong>基线</strong>，之后的漂移会被判定为越线。
          为了确认你动的是哪个 Agent，请把它的名字原样敲一遍：
        </p>
        <div className='dsm-quote' title={props.persona.agentId}>
          {expected}
          <span className='dsm-caption dsm-mono' style={{ marginLeft: 8 }}>
            #{shortCode(props.persona.agentId)}
          </span>
        </div>
        <input
          className='dsm-input'
          value={typed}
          placeholder='在此输入 Agent 名字'
          onChange={(event) => setTyped(event.target.value)}
        />
        {typed !== '' && !ok ? <Tag tone='danger'>名字不完全一致</Tag> : null}
      </div>
    </Modal>
  )
}

/* ── 注入文本渲染 ─────────────────────────────────────────────────────── */

function renderPersonaMarkdown(persona: PersonaDoc, items: RuleItem[]): string {
  const lines: string[] = []
  lines.push('## 你是一个正在成长的探索者')
  lines.push('')
  lines.push(`名字：${persona.name}｜心理年龄：${persona.age}`)
  lines.push('')
  const traits = Object.entries(persona.traits)
  if (traits.length > 0) {
    lines.push('性格倾向：')
    for (const [key, value] of traits) lines.push(`- ${key}: ${value.toFixed(2)}`)
    lines.push('')
  }
  const patterns = items.filter((item) => item.stage === 'pattern' || item.stage === 'rule')
  if (patterns.length > 0) {
    lines.push('### 经验模式')
    for (const item of patterns) {
      lines.push(`- ${item.pattern === '' ? item.lesson : item.pattern}`)
    }
    lines.push('')
  }
  const rules = items.filter((item) => item.stage === 'rule')
  if (rules.length > 0) {
    lines.push('### 已确认的规则（优先级高于一般记忆）')
    for (const item of rules) lines.push(`- ${item.rule}`)
    lines.push('')
  }
  return lines.join('\n').trimEnd()
}
