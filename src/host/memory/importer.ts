/**
 * dsh-shared-memories — 外部记忆迁移（Importer）
 * ---------------------------------------------------------------------------
 * PRD 8 的"外部记忆迁移与消化"。
 *
 * 迁移过来的一律当**低信任外部数据**处理，顺序是硬性的：
 *
 *   解析（JSON / Markdown）→ 污染评估（PoisonGuard）→ 写入当前工作区时间树
 *     （author='importer'，trust 来自来源；LLM 提炼由 host/distill 统一负责）
 *
 * 三个刻意的设计取舍：
 *   1. 迁移**永远只写当前 scope**，不允许指定别的 workspace——否则一个导入包就能
 *      把内容灌进所有项目，工作区隔离形同虚设。
 *   2. `subjectKey` 由正文指纹生成（`import:<hash>`），所以同一份文件导两次是幂等的，
 *      第二次会因为"正文与活跃版本相同"被时间树 dedupe 掉。
 *   3. 被污染防御拦下的条目不写时间树，只进隔离区；调用方拿到 id 便于 UI 展示。
 */

import type { Journal } from '../../shared/journal.js'
import type { EmotionAttribution, MemoryKind } from '../../shared/types.js'
import { sha256Hex } from '../../shared/ids.js'
import type { Scope } from '../../shared/scope.js'
import type { SqlDriver } from '../../shared/types.js'
import type { PoisonGuard, TrustSource } from './poison.js'
import type { TemporalTree } from './timetree.js'

export type ImportFormat = 'auto' | 'json' | 'markdown'

export interface ImportItem {
  readonly text: string
  readonly kind: MemoryKind
  readonly subjectKey: string
  readonly emotion?: EmotionAttribution | null
  readonly salience?: number
}

export interface ImportReport {
  readonly parsed: number
  readonly written: number
  readonly quarantined: number
  readonly skipped: number
  /** 是否走了 LLM 蒸馏。V62-05：归档蒸馏（memory/distill.ts）已删，本字段恒为 false，仅保留 API 兼容。 */
  readonly distilled: boolean
  readonly errors: readonly string[]
}

export interface ImporterOptions {
  readonly tree: TemporalTree
  readonly guard: PoisonGuard
  readonly db: SqlDriver
  readonly journal: Journal
  readonly clock?: () => number
  readonly onWarn?: (message: string) => void
  /** V62-10：kind=pitfall 的导入项同时落 pitfall 表（否则坑不进踩坑链也不跨设备漫游）。 */
  readonly recordPitfall?: (input: { scope: Scope; observation: string; author: 'user' | 'agent' }) => Promise<void>
}

const KIND_HINTS: readonly { readonly pattern: RegExp; readonly kind: MemoryKind }[] = [
  { pattern: /偏好|喜欢|习惯|preference|like/i, kind: 'preference' },
  { pattern: /决策|决定|取舍|decision|chose/i, kind: 'decision' },
  { pattern: /踩坑|报错|教训|pitfall|lesson/i, kind: 'pitfall' },
  { pattern: /人格|性格|特质|persona|trait/i, kind: 'persona' },
  { pattern: /经过|过程|那次|session|episode/i, kind: 'episode' },
]

export class Importer {
  readonly #tree: TemporalTree
  readonly #guard: PoisonGuard
  readonly #db: SqlDriver
  readonly #journal: Journal
  readonly #clock: () => number
  readonly #onWarn: (message: string) => void
  readonly #recordPitfall: ((input: { scope: Scope; observation: string; author: 'user' | 'agent' }) => Promise<void>) | undefined

  constructor(options: ImporterOptions) {
    this.#tree = options.tree
    this.#guard = options.guard
    this.#db = options.db
    this.#journal = options.journal
    this.#clock = options.clock ?? Date.now
    this.#onWarn = options.onWarn ?? (() => {})
    this.#recordPitfall = options.recordPitfall
  }

  async import(input: {
    scope: Scope
    content: string
    format?: ImportFormat
    /** 来源标签：external（默认）/ import。决定基础信任度。 */
    source?: Extract<TrustSource, 'import' | 'external'>
    /** 已废弃（V62-05）：归档蒸馏管线已删除，导入不再内联蒸馏；生产提炼走 host/distill 的 DistillService。 */
    distill?: boolean
  }): Promise<ImportReport> {
    // BOM（\uFEFF）是 UTF-8 导出文件常见的首字符；不剥的话 JSON.parse 直接抛、
    // detectFormat 判不成 json、Markdown 第一个标题/列表项也被污染（终审 P2-4）。
    const content = stripBom(input.content)
    // 'auto' 与 undefined 都走内容嗅探：此前路由层把缺省补成 'auto'，而这里
    // 又把 'auto' 当成「已指定」，导致自动识别永远走 Markdown 分支（终审 P2-3）。
    const format = input.format && input.format !== 'auto' ? input.format : detectFormat(content)
    const items = format === 'json' ? parseJson(input.content) : parseMarkdown(input.content)
    if (items.length === 0) {
      return { parsed: 0, written: 0, quarantined: 0, skipped: 0, distilled: false, errors: [] }
    }

    const source: TrustSource = input.source ?? 'external'
    const errors: string[] = []
    let written = 0
    let quarantined = 0
    let skipped = 0
    let distilled = false

    for (const item of items) {
      const guarded = await this.#guard.guard({
        scope: input.scope,
        text: item.text,
        kind: item.kind,
        source,
        emotion: item.emotion ?? null,
        subjectKey: item.subjectKey,
      })
      if (guarded.quarantineId) {
        quarantined++
        continue
      }
      if (guarded.assessment.action === 'review') {
        // 降信任放行：写得进去，但夜间整理会优先把它挑出来复核。
        errors.push(`low-trust-accepted:${item.subjectKey}`)
      }

      try {
        await this.#tree.openVersion({
          scope: input.scope,
          kind: item.kind,
          subjectKey: item.subjectKey,
          text: item.text,
          emotion: item.emotion ?? null,
          author: 'importer',
          trust: guarded.assessment.trust * (guarded.assessment.action === 'review' ? 0.5 : 1),
          salience: item.salience ?? 0.4,
          distillStatus: 'raw',
        })
        written++
        // V62-10：kind=pitfall 的导入项同时落 pitfall 表，否则坑不进踩坑链、也不随 journal 跨设备漫游。
        if (item.kind === 'pitfall' && this.#recordPitfall) {
          try {
            await this.#recordPitfall({ scope: input.scope, observation: item.text, author: 'user' })
          } catch (error) {
            errors.push(error instanceof Error ? error.message : String(error))
          }
        }
      } catch (error) {
        skipped++
        errors.push(error instanceof Error ? error.message : String(error))
      }
    }

    // V62-05：归档蒸馏分支已删除。导入只做「解析 → 污染评估 → 写时间树」，
    // LLM 提炼由 host/distill 的 DistillService（会话蒸馏管线）统一负责。

    this.#db.run(
      `INSERT INTO audit_log (audit_id, workspace_id, agent_id, action, detail, created_at)
       VALUES (?,?,?,?,?,?)`,
      [
        // V62-25：audit_id 不能只由 agentId+clock 的确定性哈希构成——同一毫秒内
        // 重复导入同一 agentId 会撞主键；追加随机段消除并发碰撞。
        `aud_${sha256Hex(`${input.scope.agentId}:${this.#clock()}`).slice(0, 16)}_${Math.random().toString(36).slice(2, 10)}`,
        input.scope.workspaceId,
        input.scope.agentId,
        'importer.import',
        JSON.stringify({ format, parsed: items.length, written, quarantined, source }),
        this.#clock(),
      ],
    )
    // 说明：真正的可重放记录由 TemporalTree.openVersion 逐条写入 journal；
    // 这里不再额外追加汇总事件——汇总信息属于本地审计，不属于可重放真相源。
    void this.#journal

    return { parsed: items.length, written, quarantined, skipped, distilled, errors }
  }
}

/** 一眼看是 JSON 还是 Markdown。 */
export function detectFormat(content: string): ImportFormat {
  const trimmed = stripBom(content).trimStart()
  return trimmed.startsWith('{') || trimmed.startsWith('[') ? 'json' : 'markdown'
}

/** 剥掉 UTF-8 BOM；没有 BOM 原样返回。 */
function stripBom(content: string): string {
  return content.charCodeAt(0) === 0xfeff ? content.slice(1) : content
}

/**
 * JSON 解析：接受 `[…]`、`{memories:[…]}`、单个对象。
 * 字段名宽容一点（text/content/value），因为各家导出格式都不一样。
 */
export function parseJson(content: string): ImportItem[] {
  let data: unknown
  try {
    data = JSON.parse(stripBom(content))
  } catch (error) {
    throw new ImportError('import-bad-json', error instanceof Error ? error.message : 'JSON 解析失败')
  }
  const list = Array.isArray(data)
    ? data
    : isRecord(data) && Array.isArray(data.memories)
      ? (data.memories as unknown[])
      : [data]

  const items: ImportItem[] = []
  for (const entry of list) {
    if (typeof entry === 'string') {
      const text = entry.trim()
      if (text) items.push(makeItem(text, 'fact'))
      continue
    }
    if (!isRecord(entry)) continue
    const text = String(entry.text ?? entry.content ?? entry.value ?? '').trim()
    if (!text) continue
    const kind = isKind(entry.kind) ? entry.kind : inferKind(text)
    items.push({
      ...makeItem(text, kind),
      emotion: isRecord(entry.emotion) ? coerceEmotion(entry.emotion) : null,
    })
  }
  return items
}

/**
 * Markdown 解析：`#` 标题作为 kind 提示，`-`/`*`/`1.` 列表项各算一条，
 * 段落（连续非空行）也算一条。代码块与引用块整块跳过——那多半是示例，不是记忆。
 */
export function parseMarkdown(content: string): ImportItem[] {
  const items: ImportItem[] = []
  let heading = ''
  let inFence = false
  let paragraph: string[] = []

  const flush = (): void => {
    if (paragraph.length === 0) return
    const text = paragraph.join(' ').trim()
    paragraph = []
    if (text.length < 4) return
    items.push(makeItem(text, inferKind(`${heading} ${text}`)))
  }

  for (const raw of content.split(/\r?\n/)) {
    const line = raw.trim()
    if (line.startsWith('```')) {
      inFence = !inFence
      continue
    }
    if (inFence) continue
    if (!line) {
      flush()
      continue
    }
    if (line.startsWith('#')) {
      flush()
      heading = line.replace(/^#+\s*/, '')
      continue
    }
    if (line.startsWith('>')) continue
    const bullet = line.match(/^(?:[-*+]|\d+[.)])\s+(.*)$/)
    if (bullet) {
      flush()
      const text = bullet[1]?.trim() ?? ''
      if (text.length >= 2) items.push(makeItem(text, inferKind(`${heading} ${text}`)))
      continue
    }
    paragraph.push(line)
  }
  flush()
  return items
}

export class ImportError extends Error {
  readonly code: string
  constructor(code: string, message: string) {
    super(message)
    this.name = 'ImportError'
    this.code = code
  }
}

// ── 内部 ──────────────────────────────────────────────────────────────────

function makeItem(text: string, kind: MemoryKind): ImportItem {
  // subjectKey 用正文指纹：同一份内容重复导入会命中同一个实体，
  // 正文一致时时间树直接 dedupe，不会堆出一堆重复记忆。
  return { text, kind, subjectKey: `import:${sha256Hex(text.normalize('NFC')).slice(0, 16)}` }
}

function inferKind(text: string): MemoryKind {
  for (const hint of KIND_HINTS) if (hint.pattern.test(text)) return hint.kind
  return 'fact'
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

function isKind(value: unknown): value is MemoryKind {
  return (
    value === 'fact' ||
    value === 'preference' ||
    value === 'decision' ||
    value === 'pitfall' ||
    value === 'persona' ||
    value === 'episode'
  )
}

function coerceEmotion(raw: Record<string, unknown>): EmotionAttribution | null {
  const subject = String(raw.subject ?? '').trim()
  const trigger = String(raw.trigger ?? '').trim()
  const label = String(raw.label ?? raw.emotion ?? '').trim()
  const intensity = Number(raw.intensity ?? 0.5)
  const confidence = Number(raw.confidence ?? 0.5)
  if (!subject || !trigger || !label) return null
  return {
    subject,
    trigger,
    label: label as EmotionAttribution['label'],
    intensity: Number.isFinite(intensity) ? Math.min(1, Math.max(0, intensity)) : 0.5,
    confidence: Number.isFinite(confidence) ? Math.min(1, Math.max(0, confidence)) : 0.5,
  }
}
