/**
 * dsh-shared-memories — 强制工作区隔离的检索层
 * ---------------------------------------------------------------------------
 * PRD 5 的落地方式：**让"忘记加过滤"这种事在类型层面就无法发生**。
 *
 * 四道防线：
 *   ① 唯一入口：Host 层不暴露 SqlDriver，调用方只能拿到 ScopedQuery；
 *   ② 编译期注入：所有 SQL 由 `#scopeClause()` 生成，WHERE 里一定有
 *      `e.workspace_id = ? AND e.agent_id = ?`，没有"可选"分支；
 *   ③ 结果集断言：查询回来后逐行复核，越界立刻抛 ScopeViolation（防止未来
 *      有人改 SQL 时漏了 JOIN 条件）；
 *   ④ 写入侧同权：时间树写入同样要求 scope，跨区写入抛错而不是静默落库。
 *
 * 全局检索不是布尔开关，而是一次性令牌 + 审计：`GlobalToken` 带 reason / 签发者 /
 * TTL，过期即失效，调用必须留痕。这样"我临时搜一下全库"不会变成常态。
 *
 * 召回策略参考 dsh-mneme：关键词（LIKE/BM25 代理）+ 向量（外部注入）+ 新鲜度
 * （指数衰减，参数与 brain-memory 的遗忘曲线同源）三路加权，再交给上层 rerank。
 */
import {
  assertScope,
  escapeLike,
  isGlobalTokenValid,
  ScopeViolation,
  type GlobalToken,
  type Scope,
} from '../../shared/scope.js'
import type {
  EmotionAttribution,
  EmotionLabel,
  MemoryKind,
  SqlDriver,
} from '../../shared/types.js'
import { EMOTION_LABELS } from '../../shared/types.js'

/** 三路召回权重；总和会被归一化，因此不必手动凑成 1。 */
export interface RetrievalWeights {
  readonly keyword: number
  readonly vector: number
  readonly recency: number
}

const DEFAULT_WEIGHTS: RetrievalWeights = { keyword: 0.45, vector: 0.4, recency: 0.15 }

/** 全局检索审计事件。 */
export interface GlobalAuditEvent {
  readonly reason: string
  readonly issuedBy: string
  readonly workspaceId: string
  readonly agentId: string
  readonly at: number
  readonly hits: number
}

export interface ScopedQueryOptions {
  readonly weights?: Partial<RetrievalWeights>
  /** 新鲜度半衰期（天）。默认 45：一个半月前的技术细节开始明显降权。 */
  readonly halfLifeDays?: number
  /** 是否做结果集二次断言；默认 true，仅在超大批量导出时可关。 */
  readonly assertResults?: boolean
  /** 是否允许全局检索；由 `config.isolation.allowGlobalSearch` 传入。 */
  readonly allowGlobalSearch?: boolean
  /** 全局检索审计回调；必须接 audit_log。 */
  readonly onGlobalQuery?: (event: GlobalAuditEvent) => void
  readonly clock?: () => number
}

export interface SearchOptions {
  /** 查询文本；为空表示"按重要度列表"。 */
  readonly text?: string
  readonly kinds?: readonly MemoryKind[]
  /** 时间旅行：读取该时刻活跃的版本。缺省 = 现在。 */
  readonly asOf?: number
  readonly limit?: number
  /** 进入精排前的候选池；默认 max(limit*4, 32)。 */
  readonly candidatePool?: number
  /** 向量召回：由上层（mneme 的 embedding 索引）注入 0..1 相似度。 */
  readonly vectorScore?: (row: MemoryHitSeed) => number
  /** 全局检索令牌；不传即严格隔离。 */
  readonly global?: GlobalToken
  /** 信任度下限，用于过滤低可信的外部记忆。 */
  readonly minTrust?: number
}

/** 打分前的原始命中（也是 vectorScore 回调的入参）。 */
export interface MemoryHitSeed {
  readonly entityId: string
  readonly workspaceId: string
  readonly agentId: string
  readonly kind: MemoryKind
  readonly subjectKey: string
  readonly text: string
  readonly validFrom: number
  readonly salience: number
  readonly trust: number
}

/** 带打分明细的检索结果，明细用于控制台"为什么召回这条"的展示。 */
export interface MemoryHit extends MemoryHitSeed {
  readonly versionId: string
  readonly score: number
  readonly breakdown: {
    readonly keyword: number
    readonly vector: number
    readonly recency: number
  }
  readonly emotion: EmotionAttribution | null
}

/** SQL 行形状（snake_case），与 MemoryHitSeed 一一对应。 */
interface Row {
  entity_id: string
  workspace_id: string
  agent_id: string
  kind: string
  subject_key: string
  salience: number
  trust: number
  version_id: string
  text: string
  valid_from: number
  emo_subject: string | null
  emo_trigger: string | null
  emo_label: string | null
  emo_intensity: number | null
  emo_confidence: number | null
}

const BASE_SQL = `SELECT e.entity_id, e.workspace_id, e.agent_id, e.kind, e.subject_key,
       e.salience, e.trust,
       v.version_id, v.text, v.valid_from,
       v.emo_subject, v.emo_trigger, v.emo_label, v.emo_intensity, v.emo_confidence
  FROM memory_version v
  JOIN memory_entity e ON e.entity_id = v.entity_id
 WHERE v.valid_from <= ? AND (v.valid_until IS NULL OR v.valid_until > ?)
   AND e.status = 'active'`

export class ScopedQuery {
  readonly #db: SqlDriver
  readonly #scope: Scope
  readonly #weights: RetrievalWeights
  readonly #halfLifeDays: number
  readonly #assertResults: boolean
  readonly #allowGlobalSearch: boolean
  readonly #onGlobalQuery: (event: GlobalAuditEvent) => void
  readonly #clock: () => number

  constructor(db: SqlDriver, scope: Scope, options: ScopedQueryOptions = {}) {
    assertScope(scope, 'ScopedQuery.constructor')
    this.#db = db
    this.#scope = scope
    this.#weights = { ...DEFAULT_WEIGHTS, ...options.weights }
    this.#halfLifeDays = options.halfLifeDays ?? 45
    this.#assertResults = options.assertResults ?? true
    this.#allowGlobalSearch = options.allowGlobalSearch ?? false
    this.#onGlobalQuery = options.onGlobalQuery ?? (() => {})
    this.#clock = options.clock ?? Date.now
  }

  /** 当前作用域快照（只读，避免被调用方改写后影响后续查询）。 */
  get scope(): Readonly<Scope> {
    return this.#scope
  }

  /**
   * 混合召回。默认严格隔离；传 `global` 令牌才跨工作区（并落审计）。
   */
  search(options: SearchOptions = {}): MemoryHit[] {
    const at = options.asOf ?? this.#clock()
    const global = this.#resolveGlobal(options.global)
    const limit = Math.max(1, options.limit ?? 8)
    const pool = Math.max(limit, options.candidatePool ?? Math.max(limit * 4, 32))

    const params: unknown[] = [at, at]
    let sql = BASE_SQL

    if (options.kinds && options.kinds.length > 0) {
      const placeholders = options.kinds.map(() => '?').join(',')
      sql += ` AND e.kind IN (${placeholders})`
      params.push(...options.kinds)
    }
    if (options.minTrust !== undefined) {
      sql += ` AND e.trust >= ?`
      params.push(options.minTrust)
    }
    if (options.text && options.text.trim()) {
      // LIKE 只做粗召回；真正的排序交给下面的三路打分 + 上层 rerank。
      const pattern = `%${escapeLike(options.text.trim())}%`
      sql += ` AND (v.text LIKE ? ESCAPE '\\' OR e.subject_key LIKE ? ESCAPE '\\')`
      params.push(pattern, pattern)
    }
    const clause = this.#scopeClause(global)
    sql += clause.sql
    params.push(...clause.params)
    sql += ` ORDER BY e.salience DESC, v.valid_from DESC LIMIT ?`
    params.push(pool)

    const rows = this.#db.all<Row>(sql, params)
    this.#assertRows(rows, global)

    const terms = tokenize(options.text ?? '')
    const weightSum =
      this.#weights.keyword + this.#weights.vector + this.#weights.recency || 1

    const hits: MemoryHit[] = rows.map((row) => {
      const seed: MemoryHitSeed = {
        entityId: row.entity_id,
        workspaceId: row.workspace_id,
        agentId: row.agent_id,
        kind: row.kind as MemoryKind,
        subjectKey: row.subject_key,
        text: row.text,
        validFrom: row.valid_from,
        salience: row.salience,
        trust: row.trust,
      }
      const keyword = keywordScore(seed, terms)
      const vector = clamp01(options.vectorScore?.(seed) ?? 0)
      const recency = this.#recencyScore(row.valid_from, at)
      const score =
        (this.#weights.keyword * keyword +
          this.#weights.vector * vector +
          this.#weights.recency * recency) /
        weightSum
      return {
        ...seed,
        versionId: row.version_id,
        score: round(score),
        breakdown: { keyword: round(keyword), vector: round(vector), recency: round(recency) },
        emotion: toEmotion(row),
      }
    })

    // 分数优先，重要度作为次序；再按时间新到旧，保证结果稳定可复现。
    hits.sort((a, b) => b.score - a.score || b.salience - a.salience || b.validFrom - a.validFrom)

    if (global) {
      this.#onGlobalQuery({
        reason: options.global!.reason,
        issuedBy: options.global!.issuedBy,
        workspaceId: this.#scope.workspaceId,
        agentId: this.#scope.agentId,
        at,
        hits: hits.length,
      })
    }
    return hits.slice(0, limit)
  }

  /**
   * 取某实体键的当前活跃版本（供 System Prompt 注入、去重检查使用）。
   */
  activeFor(subjectKey: string, kind?: MemoryKind): MemoryHit | undefined {
    const params: unknown[] = [this.#clock()]
    let sql = `${BASE_SQL} AND e.subject_key = ?`
    params.push(subjectKey)
    if (kind) {
      sql += ` AND e.kind = ?`
      params.push(kind)
    }
    const clause = this.#scopeClause(false)
    sql += clause.sql
    params.push(...clause.params)
    sql += ` ORDER BY v.valid_from DESC LIMIT 1`

    const row = this.#db.one<Row>(sql, params)
    if (!row) return undefined
    this.#assertRows([row], false)
    return {
      entityId: row.entity_id,
      workspaceId: row.workspace_id,
      agentId: row.agent_id,
      kind: row.kind as MemoryKind,
      subjectKey: row.subject_key,
      text: row.text,
      validFrom: row.valid_from,
      salience: row.salience,
      trust: row.trust,
      versionId: row.version_id,
      score: row.salience,
      breakdown: { keyword: 0, vector: 0, recency: 0 },
      emotion: toEmotion(row),
    }
  }

  /** 实体历史（时间旅行 + 回滚面板）。跨区访问抛 ScopeViolation。 */
  history(entityId: string): Array<{ versionId: string; text: string; validFrom: number; validUntil: number | null; author: string; distillStatus: string }> {
    const owner = this.#db.one<{ workspace_id: string; agent_id: string }>(
      `SELECT workspace_id, agent_id FROM memory_entity WHERE entity_id = ?`,
      [entityId],
    )
    if (!owner) throw new Error(`entity not found: ${entityId}`)
    if (owner.workspace_id !== this.#scope.workspaceId || owner.agent_id !== this.#scope.agentId) {
      throw new ScopeViolation('entity-out-of-scope', { entityId })
    }
    return this.#db.all<{
      version_id: string
      text: string
      valid_from: number
      valid_until: number | null
      author: string
      distill_status: string
    }>(
      `SELECT version_id, text, valid_from, valid_until, author, distill_status
         FROM memory_version WHERE entity_id = ?
        ORDER BY valid_from DESC, seq DESC`,
      [entityId],
    ).map((row) => ({
      versionId: row.version_id,
      text: row.text,
      validFrom: row.valid_from,
      validUntil: row.valid_until,
      author: row.author,
      distillStatus: row.distill_status,
    }))
  }

  /** 当前作用域的规模统计（控制台首页/健康检查用）。 */
  stats(): { entities: number; activeVersions: number } {
    const clause = this.#scopeClause(false)
    const entities =
      this.#db.one<{ n: number }>(
        `SELECT COUNT(*) AS n FROM memory_entity e WHERE e.status = 'active'${clause.sql}`,
        clause.params,
      )?.n ?? 0
    const activeVersions =
      this.#db.one<{ n: number }>(
        `SELECT COUNT(*) AS n FROM memory_version v
           JOIN memory_entity e ON e.entity_id = v.entity_id
          WHERE v.valid_until IS NULL AND e.status = 'active'${clause.sql}`,
        clause.params,
      )?.n ?? 0
    return { entities, activeVersions }
  }

  // ── 内部实现 ────────────────────────────────────────────────────────────

  /**
   * 生成隔离条件。
   * `global === true` 时返回空串——但只有拿到合法令牌才会走到这里。
   */
  #scopeClause(global: boolean): { sql: string; params: unknown[] } {
    if (global) return { sql: '', params: [] }
    return {
      sql: ` AND e.workspace_id = ? AND e.agent_id = ?`,
      params: [this.#scope.workspaceId, this.#scope.agentId],
    }
  }

  /** 令牌校验 + 审计前置检查；返回是否放行全局检索。 */
  #resolveGlobal(token: GlobalToken | undefined): boolean {
    if (!token) return false
    if (!this.#allowGlobalSearch) {
      throw new ScopeViolation('global-search-disabled', { workspaceId: this.#scope.workspaceId })
    }
    // 先把 reason 取出来再校验：`isGlobalTokenValid` 是类型谓词，
    // 传进去之后 TS 会把 else 分支的 token 收窄成 never，`token.reason` 直接编译失败。
    const reason = token.reason
    if (!isGlobalTokenValid(token, this.#clock())) {
      throw new ScopeViolation('global-token-invalid', { reason })
    }
    return true
  }

  /**
   * 结果集断言：即便 SQL 被改坏，也不会把别的工作区的记忆吐给模型。
   * 这是"最后一道防线"，不是主防线——主防线是 SQL 本身。
   */
  #assertRows(rows: readonly Row[], global: boolean): void {
    if (global || !this.#assertResults) return
    for (const row of rows) {
      if (row.workspace_id !== this.#scope.workspaceId || row.agent_id !== this.#scope.agentId) {
        throw new ScopeViolation('result-out-of-scope', {
          entityId: row.entity_id,
          expected: { workspaceId: this.#scope.workspaceId, agentId: this.#scope.agentId },
          actual: { workspaceId: row.workspace_id, agentId: row.agent_id },
        })
      }
    }
  }

  /** 新鲜度：指数衰减，半衰期可配；与 FSRS 的"留存随时间下降"同构。 */
  #recencyScore(validFrom: number, at: number): number {
    const ageDays = Math.max(0, (at - validFrom) / 86_400_000)
    return Math.exp(-ageDays / Math.max(0.5, this.#halfLifeDays))
  }
}

/**
 * 极简分词：
 *  - 拉丁文按非字母数字切分并小写；
 *  - CJK 连续段额外产出 bigram（"同步策略" → "同步"/"步策"/"策略"），
 *    在没有分词器的情况下也能获得可用的召回率。
 */
export function tokenize(text: string): string[] {
  const trimmed = text.trim()
  if (!trimmed) return []
  const out = new Set<string>()
  const lower = trimmed.toLowerCase()
  for (const part of lower.split(/[^\p{L}\p{N}_-]+/u)) {
    if (!part) continue
    if (/^[\p{Script=Han}]+$/u.test(part)) {
      if (part.length <= 2) {
        out.add(part)
      } else {
        for (let i = 0; i < part.length - 1; i++) out.add(part.slice(i, i + 2))
      }
    } else {
      out.add(part)
    }
  }
  return [...out]
}

/** 关键词得分 = 命中词数 / 总词数（0..1），命中实体键额外加权。 */
function keywordScore(seed: MemoryHitSeed, terms: readonly string[]): number {
  if (terms.length === 0) return 0
  const haystack = seed.text.toLowerCase()
  const subject = seed.subjectKey.toLowerCase()
  let hits = 0
  for (const term of terms) {
    if (haystack.includes(term)) hits += 1
    else if (subject.includes(term)) hits += 0.6
  }
  return clamp01(hits / terms.length)
}

/** 数据库的平铺情感列还原成结构化对象；任一字段缺失即整体为 null。 */
function toEmotion(row: Row): EmotionAttribution | null {
  if (!row.emo_label || !row.emo_subject || !row.emo_trigger) return null
  if (!EMOTION_LABELS.includes(row.emo_label as EmotionLabel)) return null
  return {
    subject: row.emo_subject,
    trigger: row.emo_trigger,
    label: row.emo_label as EmotionLabel,
    intensity: clamp01(row.emo_intensity ?? 0),
    confidence: clamp01(row.emo_confidence ?? 0),
  }
}

function clamp01(value: number): number {
  if (!Number.isFinite(value)) return 0
  return Math.min(1, Math.max(0, value))
}

function round(value: number): number {
  return Math.round(value * 1000) / 1000
}
