/**
 * dsh-shared-memories — 展示层格式化（client/format.ts）
 * ---------------------------------------------------------------------------
 * 只放"把数字/时间变成人话"的纯函数，全部无副作用、不碰 DOM。
 *
 * 时间一律走 `Intl.DateTimeFormat('zh-CN')` 而不是 `toLocaleString()`：
 * 后者跟着浏览器语言走，同一个面板在英文系统上会突然冒出 `Jan 15` —— 汉化就漏了。
 */

const DATE_TIME = new Intl.DateTimeFormat('zh-CN', {
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  hour12: false,
})

const DATE_ONLY = new Intl.DateTimeFormat('zh-CN', { year: 'numeric', month: '2-digit', day: '2-digit' })

/** `2026/01/15 12:30`。时间戳非法时返回占位符，绝不显示 `Invalid Date`。 */
export function formatDateTime(value: number): string {
  if (!Number.isFinite(value) || value <= 0) return '时间未知'
  return DATE_TIME.format(new Date(value))
}

/** `2026/01/15`。 */
export function formatDate(value: number): string {
  if (!Number.isFinite(value) || value <= 0) return '日期未知'
  return DATE_ONLY.format(new Date(value))
}

/** 相对时间：刚刚 / 12 分钟前 / 3 小时前 / 2 天前，超过一周退回日期。 */
export function formatRelative(value: number, now: number = Date.now()): string {
  if (!Number.isFinite(value) || value <= 0) return '时间未知'
  const delta = now - value
  if (delta < 0) return '刚刚'
  const minute = 60_000
  const hour = 60 * minute
  const day = 24 * hour
  if (delta < minute) return '刚刚'
  if (delta < hour) return `${Math.floor(delta / minute)} 分钟前`
  if (delta < day) return `${Math.floor(delta / hour)} 小时前`
  if (delta < 7 * day) return `${Math.floor(delta / day)} 天前`
  return formatDate(value)
}

/** 字节数：1.2 KB / 3.4 MB。 */
export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 B'
  const units = ['B', 'KB', 'MB', 'GB']
  let value = bytes
  let index = 0
  while (value >= 1024 && index < units.length - 1) {
    value /= 1024
    index += 1
  }
  const digits = value >= 100 || index === 0 ? 0 : 1
  return `${value.toFixed(digits)} ${units[index] ?? 'B'}`
}

/** 长 id 只留前 8 位：卡片底下不该出现 36 位 uuid。 */
export function shortId(id: string | null | undefined, length = 8): string {
  if (!id) return '—'
  return id.length <= length ? id : id.slice(0, length)
}

/**
 * 代号：把 `session-8cc26eb7-a58c-4921-998e-a55187dfca93` 这类长 id
 * 压成人类看得懂的 4 个字符。
 *
 *   session-8cc26eb7-…     → 8cc2   （hex 体取前 4 位，和用户说的 `Agent - 8cc2` 对齐）
 *   ws-preview-7f3a91c2    → 91c2   （非 hex 体取尾部，前端变体多，尾部才是区分度）
 *   lead                   → lead   （本来就短，原样返回）
 *
 * 只用于**展示**，别拿它做 key 或回传后端。
 */
export function shortCode(id: string | null | undefined, length = 4): string {
  if (!id) return '—'
  const body = id.replace(/^(session|agent|ws|workspace|snap|snapshot|file|task|req|pitfall|quarantine)[-_:]/i, '')
  if (/^[0-9a-f][0-9a-f-]{7,}/i.test(body)) return body.slice(0, length)
  return body.length <= 12 ? body : body.slice(-length)
}

/**
 * Agent 的展示名：**永远优先人名**，没有名字才退回代号。
 * 界面上看到的应该是「大肥鱼」，而不是一串 uuid。
 */
export function agentLabel(agent: { name?: string | null; agentId: string }): string {
  const name = (agent.name ?? '').trim()
  if (name !== '') return name
  return `Agent · ${shortCode(agent.agentId)}`
}

/** 0.873 → `87%`（信任度/显著度用）。 */
export function formatPercent(value: number): string {
  if (!Number.isFinite(value)) return '—'
  const clamped = Math.min(1, Math.max(0, value))
  return `${Math.round(clamped * 100)}%`
}

/** 信任度分档，决定信任条的颜色与文案。 */
export function trustLevel(value: number): { label: string; tone: 'ok' | 'mid' | 'low' } {
  if (!Number.isFinite(value)) return { label: '未知', tone: 'low' }
  if (value >= 0.8) return { label: '高', tone: 'ok' }
  if (value >= 0.5) return { label: '中', tone: 'mid' }
  return { label: '低', tone: 'low' }
}
