/**
 * dsh-shared-memories — 通用视觉原件（client/ui.tsx）
 * ---------------------------------------------------------------------------
 * 这里只放"没有业务语义"的零件：胶囊、标签、信任度条、骨架屏、横幅、弹层。
 * 所有颜色/阴影/圆角都走 `styles.ts` 里的 `dsm-*` 类与 `--dsm-*` 令牌，
 * 组件本身不出现任何 Tailwind 类名，也不写死色值——深浅色由宿主主题变量兜住。
 */

import { useEffect, type CSSProperties, type ReactNode } from 'react'
import type { RestorePhase } from '../shared/console-api.js'
import { phaseLabel } from './i18n.js'

/* ── 胶囊筛选 ─────────────────────────────────────────────────────────── */

export function Pill(props: {
  label: ReactNode
  active?: boolean
  onClick?: () => void
  /** 小圆点颜色（CSS 颜色或 `var(--dsm-joy)` 之类），不传则不画点。 */
  dot?: string
  /** 虚线描边：表示"可选但当前未参与筛选"的弱操作（如全局检索开关）。 */
  quiet?: boolean
  title?: string
}): ReactNode {
  const className = props.quiet ? 'dsm-pill dsm-pill--quiet' : 'dsm-pill'
  return (
    <button
      type="button"
      className={className}
      data-active={props.active === true}
      onClick={props.onClick}
      title={props.title}
      aria-pressed={props.active === true}
    >
      {props.dot === undefined ? null : (
        <span className='dsm-pill-dot' style={{ background: props.dot }} aria-hidden='true' />
      )}
      {props.label}
    </button>
  )
}

/* ── 标签 / 状态点 ────────────────────────────────────────────────────── */

export type TagTone = 'accent' | 'ok' | 'warn' | 'danger' | 'idle' | 'outline'

export function Tag(props: { children: ReactNode; tone?: TagTone; title?: string }): ReactNode {
  const tone = props.tone ?? 'idle'
  return (
    <span className={`dsm-tag dsm-tag--${tone}`} title={props.title}>
      {props.children}
    </span>
  )
}

export function StatusDot(props: { tone?: 'ok' | 'warn' | 'danger' | 'idle'; title?: string }): ReactNode {
  const tone = props.tone ?? 'idle'
  return <span className={`dsm-dot dsm-dot--${tone}`} title={props.title} aria-hidden='true' />
}

/* ── 情感色签 ─────────────────────────────────────────────────────────── */

/**
 * 情感 → 配色类。只有 `styles.ts` 里定义过 `--dsm-emo` 的几种才有专属颜色，
 * 其余（fear/surprise/gratitude/loneliness…）统一落到 `--neutral`，
 * 保证"新情感标签冒出来"时不会掉成一个没有颜色定义的空壳。
 */
const EMOTION_CLASS: Record<string, string> = {
  joy: 'joy',
  anxiety: 'anxiety',
  frustration: 'frustration',
  pride: 'pride',
  curiosity: 'curiosity',
  anger: 'anger',
  sadness: 'sadness',
  neutral: 'neutral',
}

export function EmotionChip(props: {
  label: string
  text?: string
  intensity?: number
  onClick?: () => void
  /** 没有情感数据时的占位胶囊（"标注情感"）。 */
  placeholder?: boolean
  title?: string
}): ReactNode {
  if (props.placeholder === true) {
    const className = props.onClick === undefined ? 'dsm-emo dsm-emo--dashed' : 'dsm-emo dsm-emo--dashed'
    return (
      <button type='button' className={className} onClick={props.onClick} title={props.title} disabled={props.onClick === undefined}>
        {props.text ?? '标注情感'}
      </button>
    )
  }
  const tone = EMOTION_CLASS[props.label] ?? 'neutral'
  const content = props.text === undefined ? props.text : props.text
  return (
    <button
      type='button'
      className={`dsm-emo dsm-emo--${tone}`}
      onClick={props.onClick}
      disabled={props.onClick === undefined}
      title={props.title}
      style={props.onClick === undefined ? { cursor: 'default' } : undefined}
    >
      {content}
      {typeof props.intensity === 'number' ? (
        <span className='dsm-num' style={{ opacity: 0.7 }}>
          {Math.round(props.intensity * 100)}%
        </span>
      ) : null}
    </button>
  )
}

/* ── 信任度 ───────────────────────────────────────────────────────────── */

export function TrustBar(props: { value: number; label?: string; tone: 'ok' | 'mid' | 'low' }): ReactNode {
  const pct = Math.max(0, Math.min(100, Math.round(props.value * 100)))
  const style: CSSProperties = { width: `${pct}%` }
  return (
    <span className='dsm-trust' data-tone={props.tone} title={`信任度 ${pct}%`}>
      <span className='dsm-trust-track'>
        <span className='dsm-trust-fill' style={style} />
      </span>
      <span className='dsm-caption dsm-num'>{props.label ?? `${pct}%`}</span>
    </span>
  )
}

/* ── 横幅 ─────────────────────────────────────────────────────────────── */

export function PhaseBanner(props: {
  phase: RestorePhase
  detail?: string | null
  onRetry?: () => void
}): ReactNode {
  if (props.phase === 'ready') return null
  const failed = props.phase === 'degraded'
  return (
    <div className={failed ? 'dsm-banner dsm-banner--danger' : 'dsm-banner'} role='status'>
      <span className={failed ? 'dsm-dot dsm-dot--danger' : 'dsm-dot dsm-dot--warn'} style={{ marginTop: 6 }} />
      <div style={{ minWidth: 0, flex: '1 1 auto' }}>
        <div className='dsm-banner-title'>{phaseLabel(props.phase)}</div>
        {failed ? (
          <div className='dsm-banner-hint'>恢复链路没有走完，当前展示的是缓存态；可以重试一次冷启动恢复。</div>
        ) : null}
        {props.detail === undefined || props.detail === null || props.detail === '' ? null : (
          <div className='dsm-banner-detail'>{props.detail}</div>
        )}
      </div>
      {failed && props.onRetry !== undefined ? (
        <button type='button' className='dsm-btn dsm-btn--sm' onClick={props.onRetry}>
          重试
        </button>
      ) : null}
    </div>
  )
}

/* ── 空态 / 骨架 ──────────────────────────────────────────────────────── */

export function EmptyState(props: {
  icon?: string
  title: string
  hint?: string
  action?: { label: string; onClick: () => void }
}): ReactNode {
  return (
    <div className='dsm-empty'>
      <div className='dsm-empty-icon' aria-hidden='true'>
        {props.icon ?? '◍'}
      </div>
      <div className='dsm-empty-title'>{props.title}</div>
      {props.hint === undefined ? null : <div className='dsm-empty-hint'>{props.hint}</div>}
      {props.action === undefined ? null : (
        <button type='button' className='dsm-btn dsm-btn--sm' onClick={props.action.onClick} style={{ marginTop: 4 }}>
          {props.action.label}
        </button>
      )}
    </div>
  )
}

export function SkeletonLine(props: { width?: string | number; height?: number }): ReactNode {
  const width = props.width ?? '100%'
  return <span className='dsm-skel' style={{ width, height: props.height ?? 12 }} aria-hidden='true' />
}

export function CardSkeleton(props: { rows?: number }): ReactNode {
  const rows = props.rows ?? 3
  const lines = Array.from({ length: rows }, (_, index) => index)
  return (
    <div className='dsm-skel-card' aria-hidden='true'>
      <div className='dsm-row' style={{ gap: 8 }}>
        <SkeletonLine width={64} height={16} />
        <SkeletonLine width={48} height={16} />
      </div>
      {lines.map((index) => (
        <SkeletonLine key={index} width={index === rows - 1 ? '62%' : '100%'} height={11} />
      ))}
    </div>
  )
}

/* ── Toast ────────────────────────────────────────────────────────────── */

export function Toast(props: { kind: 'ok' | 'error'; message: string }): ReactNode {
  return (
    <div className={props.kind === 'error' ? 'dsm-toast dsm-toast--error' : 'dsm-toast'} role='status'>
      {props.message}
    </div>
  )
}

/* ── 弹层 ─────────────────────────────────────────────────────────────── */

export function Modal(props: {
  title: ReactNode
  children?: ReactNode
  actions?: ReactNode
  onClose?: () => void
}): ReactNode {
  // Esc 关闭：只在挂载期间监听，避免每次 render 重复绑定。
  useEffect(() => {
    if (props.onClose === undefined) return
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') props.onClose?.()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [props.onClose])

  return (
    <div
      className='dsm-modal-mask'
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) props.onClose?.()
      }}
    >
      <div className='dsm-modal' role='dialog' aria-modal='true'>
        <div className='dsm-modal-head'>
          <div className='dsm-modal-title'>{props.title}</div>
        </div>
        {props.children === undefined ? null : <div className='dsm-modal-body'>{props.children}</div>}
        {props.actions === undefined ? null : <div className='dsm-modal-actions'>{props.actions}</div>}
      </div>
    </div>
  )
}

/* ── 小图标（内联 SVG，不引第三方图标库） ─────────────────────────────── */

export function SearchIcon(): ReactNode {
  return (
    <svg width='14' height='14' viewBox='0 0 24 24' fill='none' stroke='currentColor' strokeWidth='2' strokeLinecap='round'>
      <circle cx='11' cy='11' r='7' />
      <path d='M20 20l-3.6-3.6' />
    </svg>
  )
}

export function ChevronIcon(props: { open?: boolean }): ReactNode {
  return (
    <span className='dsm-caret' style={{ display: 'inline-block', transform: props.open === true ? 'rotate(180deg)' : 'none', transition: 'transform 140ms ease' }}>
      ▾
    </span>
  )
}

/** 简易统计块：数字 + 说明，用于顶部概览与列表头。 */
export function Stat(props: { value: ReactNode; label: string; title?: string }): ReactNode {
  return (
    <div className='dsm-stat' title={props.title}>
      <span className='dsm-stat-value'>{props.value}</span>
      <span className='dsm-stat-label'>{props.label}</span>
    </div>
  )
}
