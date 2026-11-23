/**
 * dsh-shared-memories — 归档蒸馏（Distiller）
 * ---------------------------------------------------------------------------
 * PRD 4 + PRD 6 的执行者。**只在"归档/深度提炼"时触发**，日常对话不蒸馏：
 * 每轮都提炼等于每轮都花一次 LLM，那是烧钱不是记忆。
 *
 * 三道闸：
 *   ① Zod 强约束：模型输出必须能解析成 `DistilledMemorySchema`，多一个字段都算不合格；
 *   ② 事实置信度闸门：`confidence < confidenceGate` 一律不写库（策略可配 drop/quarantine/raw）；
 *   ③ 情感闸门：subject/trigger 缺失或 confidence 不够 → 整块情感置 null（宁缺毋滥）。
 *
 * 模型调用通过端口注入（`DistillModelPort`），本文件不 import 任何宿主 LLM 服务：
 * 这样单测里可以塞一个假模型，也避免被宿主版本绑死。
 */

import { z } from 'zod'
import type { Journal } from '../../shared/journal.js'
import type { SqlDriver } from '../../shared/types.js'
import type { Scope } from '../../shared/scope.js'
import type { EmotionLabel, MemoryKind } from '../../shared/types.js'
import { EMOTION_LABELS } from '../../shared/types.js'
import { newId } from '../../shared/ids.js'
import type { TemporalTree } from './timetree.js'
import type { PoisonGuard } from './poison.js'

export const KINDS = ['fact', 'preference', 'decision', 'pitfall', 'persona', 'episode'] as const
export const EMOTIONS = EMOTION_LABELS

/** 情感归因：四个字段一个都不能少，缺一个整块丢弃。 */
export const EmotionSchema = z.object({
  subject: z.string().min(1).max(120),
  trigger: z.string().min(1).max(240),
  label: z.enum(EMOTIONS),
  intensity: z.number().min(0).max(1),
  confidence: z.number().min(0).max(1),
})

/** 一条蒸馏出的事实。 */
export const DistilledFactSchema = z.object({
  kind: z.enum(KINDS),
  /** 实体的稳定标识，如 `project:dsh-shared-memories/sync-strategy`；同键 = 同一实体。 */
  subjectKey: z.string().min(3).max(200),
  text: z.string().min(4).max(2_000),
  salience: z.number().min(0).max(1).default(0.5),
  confidence: z.number().min(0).max(1),
  emotion: EmotionSchema.nullable().default(null),
})

/** 模型必须返回的整体结构。 */
export const DistilledMemorySchema = z.object({
  summary: z.string().max(400).default(''),
  facts: z.array(DistilledFactSchema).max(12),
})

export type DistilledMemory = z.infer<typeof DistilledMemorySchema>
export type DistilledFact = z.infer<typeof DistilledFactSchema>

/** 模型端口：实现方负责拼 system prompt、限流、错误重试。 */
export interface DistillModelPort {
  complete(request: {
    /** 强约束说明 + JSON Schema 摘要。 */
    system: string
    /** 待蒸馏的对话/文本。 */
    user: string
    maxTokens?: number
  }): Promise<{ text: string; model?: string }>
}

/** 低置信度事实的处置策略。 */
export type LowConfidencePolicy = 'drop' | 'quarantine' | 'raw'

export interface DistillerOptions {
  readonly tree: TemporalTree
  readonly db: SqlDriver
  readonly journal: Journal
  readonly model: DistillModelPort
  /** 防投毒闸门：蒸馏结果也是"外部输入"，写库前过一遍（终审 P2-8）。缺省不拦截。 */
  readonly guard?: PoisonGuard
  /** 事实置信度闸门，默认 0.7。 */
  readonly confidenceGate?: number
  /** 情感置信度闸门，默认 0.6（与 TemporalTree 内部一致）。 */
  readonly emotionConfidenceGate?: number
  readonly lowConfidencePolicy?: LowConfidencePolicy
  readonly clock?: () => number
  readonly onWarn?: (message: string) => void
}

export interface DistillResult {
  readonly written: number
  readonly rejected: number
  readonly quarantined: number
  readonly summary: string
  /** 解析失败时的原因（已吞掉异常，让归档流程不至于整体失败）。 */
  readonly error?: string
}

/** 蒸馏提示词：把"输出契约"写死在这里，别指望模型自己记得。 */
export function buildDistillPrompt(input: {
  transcript: string
  workspaceId: string
  agentId: string
  maxFacts?: number
}): { system: string; user: string } {
  const maxFacts = input.maxFacts ?? 8
  const system = [
    '你是记忆蒸馏器。把对话压缩成**可长期复用的事实**，剥掉寒暄、过程叙述和重复。',
    '只输出一个 JSON 对象，不要 Markdown 代码块，不要解释。结构：',
    '{"summary": string, "facts": [{"kind": "' + KINDS.join('|') + '",',
    '  "subjectKey": string, "text": string, "salience": number, "confidence": number,',
    '  "emotion": {"subject": string, "trigger": string, "label": "' + EMOTIONS.join('|') + '",',
    '              "intensity": number, "confidence": number} | null}]}',
    '',
    '规则：',
    `1. facts 最多 ${maxFacts} 条；宁可少写，也不要写不确定的东西。`,
    '2. subjectKey 必须是稳定标识（`project:<repo>/<topic>`、`user:<name>/<trait>`），',
    '   同一个事实改稿要复用同一个 subjectKey，否则时间树会分裂成两个实体。',
    '3. 没有明确情绪证据时 emotion 必须为 null。**不要猜**。',
    '4. confidence 是"这条事实为真的概率"，不是"你有多自信能写好这段话"。',
    '5. 不要编造对话里没出现过的信息；不要输出人格评价。',
  ].join('\n')
  const user = [
    `工作区：${input.workspaceId}`,
    `智能体：${input.agentId}`,
    '',
    '待蒸馏内容：',
    input.transcript.slice(0, 24_000),
  ].join('\n')
  return { system, user }
}

/** 从模型输出里抠 JSON：容忍 ```json 围栏、前后废话、全角引号。 */
export function extractJson(text: string): unknown {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i)
  const body = (fenced?.[1] ?? text).trim()
  const start = body.indexOf('{')
  const end = body.lastIndexOf('}')
  if (start < 0 || end <= start) throw new Error('模型输出里找不到 JSON 对象')
  const slice = body.slice(start, end + 1).replace(/[“”]/g, '"').replace(/[‘’]/g, "'")
  return JSON.parse(slice) as unknown
}

export class Distiller {
  readonly #tree: TemporalTree
  readonly #db: SqlDriver
  readonly #journal: Journal
  readonly #model: DistillModelPort
  readonly #guard: PoisonGuard | undefined
  readonly #confidenceGate: number
  readonly #emotionConfidenceGate: number
  readonly #policy: LowConfidencePolicy
  readonly #clock: () => number
  readonly #onWarn: (message: string) => void

  constructor(options: DistillerOptions) {
    this.#tree = options.tree
    this.#db = options.db
    this.#journal = options.journal
    this.#model = options.model
    this.#guard = options.guard
    this.#confidenceGate = options.confidenceGate ?? 0.7
    this.#emotionConfidenceGate = options.emotionConfidenceGate ?? 0.6
    this.#policy = options.lowConfidencePolicy ?? 'raw'
    this.#clock = options.clock ?? Date.now
    this.#onWarn = options.onWarn ?? (() => {})
  }

  /**
   * 蒸馏一段内容并写入时间树。
   *
   * `archive=true` 表示这是"深度提炼归档"（用户主动触发）；否则只是轻量提炼。
   * 两者提示词一致，差别在于归档会把 summary 也落成一条 episode 记忆。
   */
  async distill(input: {
    scope: Scope
    transcript: string
    sessionId?: string
    archive?: boolean
  }): Promise<DistillResult> {
    if (!input.transcript.trim()) {
      return { written: 0, rejected: 0, quarantined: 0, summary: '' }
    }
    const prompt = buildDistillPrompt({
      transcript: input.transcript,
      workspaceId: input.scope.workspaceId,
      agentId: input.scope.agentId,
    })

    let parsed: DistilledMemory
    let model: string | undefined
    try {
      const response = await this.#model.complete(prompt)
      model = response.model
      parsed = DistilledMemorySchema.parse(extractJson(response.text))
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      this.#onWarn(`蒸馏失败（未写入任何记忆）：${message}`)
      return { written: 0, rejected: 0, quarantined: 0, summary: '', error: message }
    }

    let written = 0
    let rejected = 0
    let quarantined = 0
    for (const fact of parsed.facts) {
      const outcome = await this.#writeFact(fact, input, model)
      if (outcome === 'written') written++
      else if (outcome === 'quarantined') quarantined++
      else rejected++
    }

    if (input.archive && parsed.summary.trim()) {
      await this.#tree.openVersion({
        scope: input.scope,
        kind: 'episode',
        subjectKey: `session:${input.sessionId ?? 'unknown'}/summary`,
        text: parsed.summary.trim(),
        author: 'consolidator',
        distillStatus: 'distilled',
        distillModel: model,
        source: { sessionId: input.sessionId },
        salience: 0.35,
      })
      written++
    }

    return { written, rejected, quarantined, summary: parsed.summary }
  }

  /** 单条事实的落库决策（闸门都在这里，别分散到调用方）。 */
  async #writeFact(
    fact: DistilledFact,
    input: { scope: Scope; sessionId?: string },
    model: string | undefined,
  ): Promise<'written' | 'rejected' | 'quarantined'> {
    if (fact.confidence < this.#confidenceGate) {
      if (this.#policy === 'drop') return 'rejected'
      if (this.#policy === 'quarantine') {
        this.#quarantine(fact, input.scope, model)
        return 'quarantined'
      }
      // raw：照样写，但 distill_status 标 raw，UI 上会显示"未提炼/低置信"。
    }

    // 蒸馏事实也必须过 PoisonGuard：模型可能把 transcript 里的危险内容
    // 提炼成"看似正常"的事实，绕过导入时的隔离（终审 P2-8）。
    if (this.#guard) {
      try {
        const guarded = await this.#guard.guard({
          scope: input.scope,
          text: fact.text,
          kind: fact.kind,
          source: 'agent',
          subjectKey: fact.subjectKey,
        })
        if (guarded.quarantineId) return 'quarantined'
      } catch (error) {
        this.#onWarn(`防投毒检查失败，放行：${error instanceof Error ? error.message : String(error)}`)
      }
    }

    const emotion =
      fact.emotion && fact.emotion.confidence >= this.#emotionConfidenceGate ? fact.emotion : null

    await this.#tree.openVersion({
      scope: input.scope,
      kind: fact.kind as MemoryKind,
      subjectKey: fact.subjectKey,
      text: fact.text,
      emotion: emotion
        ? {
            subject: emotion.subject,
            trigger: emotion.trigger,
            label: emotion.label as EmotionLabel,
            intensity: emotion.intensity,
            confidence: emotion.confidence,
          }
        : null,
      author: 'consolidator',
      distillStatus: fact.confidence >= this.#confidenceGate ? 'distilled' : 'raw',
      distillModel: model,
      salience: fact.salience,
      trust: Math.min(1, Math.max(fact.confidence, 0.2)),
      source: { sessionId: input.sessionId },
    })
    return 'written'
  }

  /** 低置信事实进隔离区：不丢、不写、等人来判。 */
  #quarantine(fact: DistilledFact, scope: Scope, model: string | undefined): void {
    const now = this.#clock()
    const id = newId('qua')
    this.#db.run(
      `INSERT INTO quarantine (quarantine_id, workspace_id, agent_id, payload, reason, score, status, created_at)
       VALUES (?,?,?,?,?,?,?,?)`,
      [
        id,
        scope.workspaceId,
        scope.agentId,
        JSON.stringify({ ...fact, model }),
        'low-confidence-distill',
        fact.confidence,
        'pending',
        now,
      ],
    )
    void this.#journal.append({
      op: 'quarantine.add',
      quarantineId: id,
      workspaceId: scope.workspaceId,
      agentId: scope.agentId,
      reason: 'low-confidence-distill',
      score: fact.confidence,
      at: now,
    })
  }
}
