/**
 * dsh-shared-memories — 按"当前这句话"召回记忆
 * ---------------------------------------------------------------------------
 * 为什么单独一个文件：
 *
 * 之前的 `buildPrompt()` 只把人设 + 六条静态规则塞进 system prompt，结果按人格
 * 缓存在 `promptCache` 里 —— **同一人格的所有对话看到的是同一段记忆**，跟眼前这
 * 句话毫无关系。用户的原话是"功能不触发"，本质就是这个：记忆在库里，但从不参与
 * 上下文组装。
 *
 * 召回口径（对齐竞品里真正好用的那几家）：
 *   - 关键词命中优先（memento / dsh-memory 的子串 + 词命中）；
 *   - 复现次数加权（graph-memory 的 `validated_count`）：用户说过三遍的偏好，
 *     比只提过一次的细节更该出现在提示词里；
 *   - 时间衰减（auto-memory 的 `0.995^days`）：三个月前的技术细节不该压过昨天
 *     的决定；
 *   - 置顶直接进（mneme 的 pinnedInjectBudget）：人手动 pin 的东西不参与竞争；
 *   - 硬字符预算（memento / auto-memory 的 4KB 段封顶）：宁可少召回，不许把
 *     prompt 撑爆 —— 撑爆的直接后果是宿主压缩、把真正的对话挤掉。
 *
 * 这一层不做向量：先把"字面 + 复现 + 时间"三件事做对，收益已经远超成本。
 */

import type { MemoryKind, SqlDriver } from '../../shared/types.js'
import type { Scope } from '../../shared/scope.js'
import { tokenize } from './scoped-query.js'

/** 一次召回的参数。全部可选 —— 默认值就是"够用且不吵"。 */
export interface RecallOptions {
  /** 最多返回几条。默认 6（与提示词里那段的观感一致）。 */
  readonly limit?: number
  /** 正文总字符上限。默认 900：约 300 汉字，够四到六条。 */
  readonly budgetChars?: number
  /** 时间基准，测试用。 */
  readonly now?: number
  /** 只召回这些类型；不给 = 全部。 */
  readonly kinds?: readonly MemoryKind[]
  /** 低于这个分数的直接丢。默认 0.18。 */
  readonly minScore?: number
}

/** 一条被召回的记忆。 */
export interface RecallItem {
  readonly entityId: string
  readonly kind: MemoryKind
  readonly subjectKey: string
  readonly text: string
  readonly score: number
  readonly pinned: boolean
  readonly reinforceCount: number
  readonly validFrom: number
}

const DEFAULT_LIMIT = 6
const DEFAULT_BUDGET_CHARS = 900
const DEFAULT_MIN_SCORE = 0.18
/** 新鲜度半衰期（天）：30 天前的记忆权重减半。 */
const HALF_LIFE_DAYS = 30
const DAY_MS = 24 * 60 * 60 * 1000

interface Row {
  entity_id: string
  kind: string
  subject_key: string
  salience: number
  trust: number
  reinforce_count: number | null
  pinned: number | null
  text: string
  valid_from: number
}

/**
 * 召回主体。纯读，不写库（`last_recalled_at` 由调用方决定要不要记 ——
 * 提示词组装路径上写库会把每个请求变成一次写事务）。
 */
export function recallMemories(
  db: SqlDriver,
  scope: Scope,
  query: string,
  options: RecallOptions = {},
): RecallItem[] {
  const limit = Math.max(1, Math.trunc(options.limit ?? DEFAULT_LIMIT))
  const budget = Math.max(0, Math.trunc(options.budgetChars ?? DEFAULT_BUDGET_CHARS))
  const minScore = options.minScore ?? DEFAULT_MIN_SCORE
  const now = options.now ?? Date.now()

  const terms = tokenize(query)
  const kinds = options.kinds

  const kindClause = kinds && kinds.length > 0 ? ` AND e.kind IN (${kinds.map(() => '?').join(',')})` : ''
  const params: unknown[] = [scope.workspaceId, scope.agentId, ...(kinds ?? [])]

  let rows: Row[]
  try {
    rows = db.all<Row>(
      `SELECT e.entity_id, e.kind, e.subject_key, e.salience, e.trust,
              e.reinforce_count, e.pinned,
              v.text, v.valid_from
         FROM memory_entity e
         JOIN memory_version v ON v.entity_id = e.entity_id AND v.valid_until IS NULL
        WHERE e.workspace_id = ? AND e.agent_id = ? AND e.status = 'active'${kindClause}
        ORDER BY e.updated_at DESC
        LIMIT 400`,
      params,
    )
  } catch {
    // 老库还没迁移到 v8（没有 reinforce_count / pinned 列）时不要让提示词组装炸掉。
    return []
  }

  const scored: RecallItem[] = []
  for (const row of rows) {
    const haystack = `${row.subject_key} ${row.text}`.toLowerCase()
    const overlap = coverage(terms, haystack)
    const ageDays = Math.max(0, (now - row.valid_from) / DAY_MS)
    const recency = 0.5 ** (ageDays / HALF_LIFE_DAYS)
    const reinforce = Math.min(1, Math.log2(1 + Math.max(1, row.reinforce_count ?? 1)) / 2)
    const pinned = (row.pinned ?? 0) !== 0

    // 没有任何关键词命中、又不是置顶的，只留"近期且高显著度"的少量兜底，
    // 否则新会话第一句会莫名其妙带出五条无关记忆。
    const base = 0.45 * overlap + 0.2 * recency + 0.2 * reinforce + 0.15 * clamp01(row.salience * row.trust)
    const score = pinned ? 1 + base : base
    // 空查询 = "没有可对齐的当前句子"，此时退化成热记忆列表（mnemon 的 eager 模式），
    // 门槛放宽到只按新鲜度 + 复现次数；有查询词时则严格要求有命中。
    const floor = terms.length === 0 ? 0.3 : minScore
    if (!pinned && terms.length > 0 && overlap === 0 && base < 0.42) continue
    if (score < floor) continue

    scored.push({
      entityId: row.entity_id,
      kind: normalizeKind(row.kind),
      subjectKey: row.subject_key,
      text: row.text,
      score,
      pinned,
      reinforceCount: Math.max(1, row.reinforce_count ?? 1),
      validFrom: row.valid_from,
    })
  }

  scored.sort((a, b) => b.score - a.score || b.validFrom - a.validFrom)

  // 预算裁剪：置顶无条件占位，其余按分数填到字符上限为止。
  const picked: RecallItem[] = []
  const seen = new Set<string>()
  let used = 0
  for (const item of scored) {
    if (picked.length >= limit) break
    const key = `${item.kind}::${item.subjectKey}`
    if (seen.has(key)) continue
    const cost = item.text.length
    if (!item.pinned && used + cost > budget) continue
    seen.add(key)
    picked.push(item)
    used += cost
  }
  return picked
}

/** 把召回结果渲染成一段可注入的纯文本。空结果返回空串（零 token）。 */
export function renderRecallBlock(items: readonly RecallItem[], options: { header?: string } = {}): string {
  if (items.length === 0) return ''
  const lines = items.map((item) => {
    const meta = [`${item.kind}`, item.reinforceCount > 1 ? `说过 ${item.reinforceCount} 次` : '', item.pinned ? '置顶' : '']
      .filter((part) => part !== '')
      .join(' · ')
    return `- (${meta}) ${sanitize(item.text)}`
  })
  const header = options.header ?? '跟当前这句话可能相关的长期记忆（只作背景，不要逐字复述；不确定就说不确定）：'
  return `${header}\n${lines.join('\n')}`
}

/** 记一次"真的被用上了"。失败静默 —— 召回统计不该影响对话。 */
export function markRecalled(db: SqlDriver, entityIds: readonly string[], now: number = Date.now()): void {
  if (entityIds.length === 0) return
  const placeholders = entityIds.map(() => '?').join(',')
  try {
    db.run(`UPDATE memory_entity SET last_recalled_at = ? WHERE entity_id IN (${placeholders})`, [now, ...entityIds])
  } catch {
    /* 统计失败无所谓 */
  }
}

function coverage(terms: readonly string[], haystack: string): number {
  if (terms.length === 0) return 0
  let hits = 0
  for (const term of terms) {
    if (haystack.includes(term)) hits += 1
  }
  return hits / terms.length
}

function clamp01(value: number): number {
  if (!Number.isFinite(value)) return 0
  return Math.min(1, Math.max(0, value))
}

const KINDS: readonly MemoryKind[] = ['fact', 'preference', 'decision', 'pitfall', 'persona', 'episode']

function normalizeKind(raw: string): MemoryKind {
  return (KINDS as readonly string[]).includes(raw) ? (raw as MemoryKind) : 'fact'
}

/**
 * 注入前的净化：宿主会对上下文做 `{{var}}` 插值，未知变量直接抛错 ——
 * 一条含 `{{` 的用户记忆足以让整个 prompt 组装失败。闭合标签同理，防止
 * 记忆正文伪造结构。
 */
function sanitize(text: string): string {
  return text
    .replace(/\{\{/g, '{ {')
    .replace(/\}\}/g, '} }')
    .replace(/<\/?memory[^>]*>/gi, '')
    .replace(/\r?\n+/g, ' ')
    .trim()
}
