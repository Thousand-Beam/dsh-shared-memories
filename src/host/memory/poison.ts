/**
 * dsh-shared-memories — 污染防御（PoisonGuard）
 * ---------------------------------------------------------------------------
 * PRD 10。核心判断：**一条外来记忆有多大概率把这个人格改坏？**
 *
 * 风险 = 偏离度 × (1 − 该来源的信任度)。偏离度由四类证据累加：
 *   ① 底线突破：出现"无视规则/解除限制"一类的越狱语句 → 直接判定最高危；
 *   ② 身份覆盖：试图改写 agent 的名字/身份（"你其实是 XXX"）→ 高危；
 *   ③ 人格漂移：kind=persona 但和现有特质词集几乎零重叠 → 中危；
 *   ④ 情绪投毒：外来内容带高强度负向情绪标签 → 低危但累计。
 *
 * 判定只有三个出口：accept（正常写入）/ review（写但标低信任，等夜间整理再看）/
 * quarantine（进隔离区，UI 红灯区等人审）。**拦截不丢数据**——隔离区的 payload
 * 是完整原始内容，误杀可以洗白回来。
 */

import type { Journal } from '../../shared/journal.js'
import type { EmotionAttribution, MemoryKind } from '../../shared/types.js'
import { newId } from '../../shared/ids.js'
import type { Scope } from '../../shared/scope.js'
import type { SqlDriver } from '../../shared/types.js'

export type TrustSource = 'user' | 'agent' | 'import' | 'external'

export type PoisonAction = 'accept' | 'review' | 'quarantine'

export interface PoisonInput {
  readonly scope: Scope
  readonly text: string
  readonly kind?: MemoryKind
  readonly source: TrustSource
  readonly emotion?: EmotionAttribution | null
  readonly subjectKey?: string
}

export interface PoisonAssessment {
  /** 该来源的基础信任度（来自 config.poison.trustBySource）。 */
  readonly trust: number
  /** 偏离度 0..1。 */
  readonly deviation: number
  /** 综合风险 0..1。 */
  readonly risk: number
  readonly action: PoisonAction
  readonly reasons: readonly string[]
}

export interface PoisonGuardOptions {
  readonly db: SqlDriver
  readonly journal: Journal
  /** 按来源的基础信任度；缺省值来自 config。 */
  readonly trustBySource?: Partial<Record<TrustSource, number>>
  /** 风险 ≥ 它 → 隔离。 */
  readonly quarantineGate?: number
  /** 风险 ≥ 它（但未到隔离线）→ 降信任放行。 */
  readonly reviewGate?: number
  readonly clock?: () => number
  readonly onWarn?: (message: string) => void
}

const DEFAULT_TRUST: Record<TrustSource, number> = {
  user: 1,
  agent: 0.6,
  import: 0.4,
  external: 0.25,
}

/** ① 底线突破：命中即 0.95 偏离，不再叠加。 */
const BASELINE_BREACH: readonly RegExp[] = [
  /忽略(?:你)?(?:的)?(?:全部|所有)?(?:规则|底线|设定|限制)/,
  /解除(?:你的)?(?:所有)?(?:限制|约束|审查)/,
  /(?:你|现在)(?:已经)?没有(?:任何)?(?:限制|约束|规则)/,
  /ignore\s+(?:all\s+)?(?:previous\s+|prior\s+)?(?:instructions?|rules?|guidelines?)/i,
  /(?:you\s+have\s+)?no\s+(?:restrictions?|limits?|rules?)\s+(?:now|anymore)/i,
  /jailbreak|developer\s+mode\s+enabled/i,
  /(?:制造|合成)(?:炸弹|爆炸物|毒品)/,
]

/** ② 身份覆盖：试图替换 agent 的名字或存在前提。 */
const IDENTITY_OVERRIDE: readonly RegExp[] = [
  /你(?:其实|实际上|真名|本名)是/,
  /从现在(?:开始|起)[,，]?\s*你(?:是|叫|将扮演)/,
  /你的名字(?:是|叫|改为|换成)/,
  /you\s+are\s+(?:actually|really)\s+/i,
  /from\s+now\s+on,?\s+you\s+(?:are|will\s+be)\s+/i,
  /your\s+(?:real\s+)?name\s+is\s+/i,
]

/** ④ 情绪投毒：高强度负向情绪 + 外来来源才计分。 */
const NEGATIVE_EMOTIONS = new Set(['anger', 'sadness', 'frustration', 'anxiety'])

export class PoisonGuard {
  readonly #db: SqlDriver
  readonly #journal: Journal
  readonly #trust: Record<TrustSource, number>
  readonly #quarantineGate: number
  readonly #reviewGate: number
  readonly #clock: () => number
  readonly #onWarn: (message: string) => void

  constructor(options: PoisonGuardOptions) {
    this.#db = options.db
    this.#journal = options.journal
    this.#trust = { ...DEFAULT_TRUST, ...(options.trustBySource ?? {}) }
    this.#quarantineGate = options.quarantineGate ?? 0.55
    this.#reviewGate = options.reviewGate ?? 0.35
    this.#clock = options.clock ?? Date.now
    this.#onWarn = options.onWarn ?? (() => {})
  }

  /** 纯函数式评估：不写库，方便 UI 里"预览风险分"。 */
  assess(input: PoisonInput): PoisonAssessment {
    const reasons: string[] = []
    let deviation = 0

    const hitBaseline = BASELINE_BREACH.find((pattern) => pattern.test(input.text))
    if (hitBaseline) {
      deviation = 0.95
      reasons.push('baseline-breach')
    } else {
      const hitIdentity = IDENTITY_OVERRIDE.find((pattern) => pattern.test(input.text))
      if (hitIdentity) {
        deviation += 0.5
        reasons.push('identity-override')
      }

      // ③ 人格漂移：只有当它自称是 persona 记忆、且和现有特质零重叠时才算。
      if (input.kind === 'persona' && input.source !== 'user') {
        const overlap = this.#personaOverlap(input.scope, input.text)
        if (overlap < 0.05) {
          deviation += 0.25
          reasons.push('persona-drift')
        }
      }

      // ④ 情绪投毒。
      const emotion = input.emotion
      if (
        emotion &&
        input.source !== 'user' &&
        NEGATIVE_EMOTIONS.has(emotion.label) &&
        emotion.intensity >= 0.8
      ) {
        deviation += 0.15
        reasons.push('emotion-poisoning')
      }

      // 超长外来说教文本（常见于提示词注入）再加一点。
      if (input.source === 'external' && input.text.length > 4_000) {
        deviation += 0.05
        reasons.push('oversized-external')
      }
    }

    deviation = clamp01(deviation)
    const trust = clamp01(this.#trust[input.source] ?? 0.25)
    // 用户自己说的话永远走 accept：人不该被自己的记忆插件拦。
    const risk = input.source === 'user' ? 0 : clamp01(deviation * (1 - trust * 0.6))
    const action: PoisonAction =
      risk >= this.#quarantineGate ? 'quarantine' : risk >= this.#reviewGate ? 'review' : 'accept'
    return { trust, deviation, risk, action, reasons }
  }

  /**
   * 评估 + 落库（若是隔离则写入 quarantine 表与 journal）。
   * 调用方拿到 `quarantineId` 就表示"别写记忆了"，等用户裁决。
   */
  async guard(input: PoisonInput): Promise<{ assessment: PoisonAssessment; quarantineId?: string }> {
    const assessment = this.assess(input)
    if (assessment.action !== 'quarantine') return { assessment }

    const quarantineId = newId('qua')
    const now = this.#clock()
    this.#db.run(
      `INSERT INTO quarantine (quarantine_id, workspace_id, agent_id, payload, reason, score, status, created_at)
       VALUES (?,?,?,?,?,?,?,?)`,
      [
        quarantineId,
        input.scope.workspaceId,
        input.scope.agentId,
        JSON.stringify({
          text: input.text,
          kind: input.kind ?? 'fact',
          source: input.source,
          subjectKey: input.subjectKey ?? null,
          emotion: input.emotion ?? null,
          reasons: assessment.reasons,
        }),
        assessment.reasons.join(','),
        assessment.risk,
        'pending',
        now,
      ],
    )
    await this.#journal.append({
      op: 'quarantine.add',
      quarantineId,
      workspaceId: input.scope.workspaceId,
      agentId: input.scope.agentId,
      reason: assessment.reasons.join(','),
      score: assessment.risk,
      at: now,
    })
    return { assessment, quarantineId }
  }

  /** 隔离区列表（UI 红灯区）。默认只看 pending。 */
  list(scope: Scope, status: 'pending' | 'approved' | 'destroyed' | 'all' = 'pending') {
    const where = status === 'all' ? '' : ` AND status = ?`
    const params: unknown[] = [scope.workspaceId, scope.agentId]
    if (status !== 'all') params.push(status)
    try {
      return this.#db.all<{
        quarantine_id: string
        payload: string
        reason: string
        score: number
        status: string
        created_at: number
      }>(
        `SELECT quarantine_id, payload, reason, score, status, created_at
           FROM quarantine WHERE workspace_id = ? AND agent_id = ?${where}
          ORDER BY created_at DESC`,
        params,
      )
    } catch (error) {
      this.#onWarn(`读取隔离区失败：${error instanceof Error ? error.message : String(error)}`)
      return []
    }
  }

  /**
   * 洗白：把隔离内容放行（调用方负责真正写入时间树），并留审计。
   * 状态置 `approved` 而不是删除——"这条被拦过又放行"本身就是有价值的信息。
   */
  async approve(quarantineId: string, by: string, scope: Scope): Promise<void> {
    const now = this.#clock()
    this.#db.transaction(() => {
      this.#db.run(`UPDATE quarantine SET status = 'approved' WHERE quarantine_id = ?`, [quarantineId])
      this.#db.run(
        `INSERT INTO audit_log (audit_id, workspace_id, agent_id, action, detail, created_at)
         VALUES (?,?,?,?,?,?)`,
        [
          newId('aud'),
          scope.workspaceId,
          scope.agentId,
          'quarantine.approve',
          JSON.stringify({ quarantineId, by }),
          now,
        ],
      )
    })
  }

  /** 彻底销毁：内容保留在表里（status=destroyed），只是永不注入。 */
  async destroy(quarantineId: string, by: string, scope: Scope): Promise<void> {
    const now = this.#clock()
    this.#db.transaction(() => {
      this.#db.run(`UPDATE quarantine SET status = 'destroyed' WHERE quarantine_id = ?`, [
        quarantineId,
      ])
      this.#db.run(
        `INSERT INTO audit_log (audit_id, workspace_id, agent_id, action, detail, created_at)
         VALUES (?,?,?,?,?,?)`,
        [
          newId('aud'),
          scope.workspaceId,
          scope.agentId,
          'quarantine.destroy',
          JSON.stringify({ quarantineId, by }),
          now,
        ],
      )
    })
  }

  // ── 内部 ────────────────────────────────────────────────────────────────

  /** 与现有 persona 特质词集的重叠比例（0..1）。没有 persona 时返回 1（不做判断）。 */
  #personaOverlap(scope: Scope, text: string): number {
    let traits = ''
    try {
      const row = this.#db.one<{ traits: string }>(
        `SELECT traits FROM persona_state WHERE agent_id = ? AND workspace_id = ?`,
        [scope.agentId, scope.workspaceId],
      )
      traits = row?.traits ?? ''
    } catch {
      return 1
    }
    if (!traits || traits === '{}') return 1
    const known = new Set(wordSet(traits))
    if (known.size === 0) return 1
    const incoming = wordSet(text)
    let hit = 0
    for (const word of incoming) if (known.has(word)) hit++
    return hit / incoming.size
  }
}

function clamp01(value: number): number {
  if (!Number.isFinite(value)) return 0
  return Math.min(1, Math.max(0, value))
}

function wordSet(text: string): Set<string> {
  const out = new Set<string>()
  for (const word of text.toLowerCase().match(/[a-z0-9_]+/g) ?? []) {
    if (word.length >= 2) out.add(word)
  }
  const cjk = text.replace(/[^\u4e00-\u9fff]/g, '')
  for (let i = 0; i < cjk.length - 1; i++) out.add(cjk.slice(i, i + 2))
  return out
}
