/**
 * dsh-shared-memories — 时间树（Temporal Tree）
 * ---------------------------------------------------------------------------
 * 模型：实体（entity）∘ 版本（version）
 *   entity  = "这条记忆说的是什么对象"（跨时间稳定，如「同步策略」「git 认证方式」）
 *   version = "在某段时间里，它的内容是什么"（区间 [valid_from, valid_until)）
 *
 * 核心不变量（**必须由本文件保证，别处不许直接写 memory_version**）：
 *   INV-1  同一 entity 在任意时刻最多只有一个活跃版本（valid_until IS NULL）。
 *   INV-2  同一 entity 的版本区间互不重叠，且按 valid_from 严格递增。
 *   INV-3  任何写入都先落 journal 再返回；数据库可由 journal 完全重建。
 *   INV-4  写入必须携带 scope，实体跨工作区/跨代理一律不可见。
 *
 * 为什么不用 UPDATE 覆盖：
 *   用户问「我上个月为什么改了同步间隔」时，覆盖式记忆答不出来。
 *   关闭旧版本 + 开启新版本，让"当时的想法"永久可查，也让多端冲突有可合并的基线。
 */
import { identityHash, newId } from '../../shared/ids.js'
import type { Journal, JournalInput } from '../../shared/journal.js'
import { assertScope, ScopeViolation, type Scope } from '../../shared/scope.js'
import type {
  Author,
  DistillStatus,
  EmotionAttribution,
  EmotionLabel,
  EntityRow,
  MemoryKind,
  SqlDriver,
  VersionRow,
} from '../../shared/types.js'

/** 情感标签白名单，与 DDL 的 CHECK 约束保持一致。 */
const EMOTION_LABELS: readonly EmotionLabel[] = [
  'joy',
  'anxiety',
  'frustration',
  'pride',
  'curiosity',
  'anger',
  'sadness',
  'neutral',
]

/** 打开（或新建）一个版本时的输入。 */
export interface OpenVersionInput {
  /** 作用域：写入侧同样强制，防止"写进别人的工作区"。 */
  readonly scope: Scope
  readonly kind: MemoryKind
  /**
   * 实体主键的自然语言形式，如 `project:dsh-shared-memories/sync-strategy`。
   * 同一 scope + kind + subjectKey 恒定映射到同一个 entity。
   */
  readonly subjectKey: string
  /** 记忆正文（蒸馏后的事实句，不是原始对话）。 */
  readonly text: string
  /** 该版本开始生效的事件时间；缺省 = 现在。允许回填历史版本。 */
  readonly validFrom?: number
  /** 结构化情感归因；null 表示本次不记录情绪。 */
  readonly emotion?: EmotionAttribution | null
  readonly distillStatus?: DistillStatus
  readonly distillModel?: string
  /** 显式指定实体（迁移/合并场景）；缺省按 subjectKey 解析。 */
  readonly entityId?: string
  readonly author?: Author
  /** 信任度覆盖；缺省用 scope.trust，再缺省按作者给基线。 */
  readonly trust?: number
  /** 重要度 0..1，影响检索排序与修剪。 */
  readonly salience?: number
  /** 溯源：来自哪个会话的哪段事件。 */
  readonly source?: {
    readonly sessionId?: string
    readonly seqStart?: number
    readonly seqEnd?: number
  }
}

/** 一次写入的结果。 */
export interface OpenedVersion {
  readonly entity: EntityRow
  /** 生效的版本（deduped 时为既有活跃版本）。 */
  readonly version: VersionRow
  /** 被本次写入关闭或切分的旧版本，供 UI 展示"变更了什么"。 */
  readonly affected: readonly VersionRow[]
  /** true = 正文与活跃版本一致，未产生新版本（幂等写入）。 */
  readonly deduped: boolean
}

export interface TemporalTreeOptions {
  /** 情感置信度闸门；低于它整块情感置 null。 */
  emotionConfidenceGate?: number
  clock?: () => number
}

/** 默认信任度：用户明确说的最可信，代理推断次之，外部导入最低。 */
const DEFAULT_TRUST: Record<Author, number> = {
  user: 1,
  agent: 0.6,
  importer: 0.25,
  consolidator: 0.5,
}

const INSERT_VERSION = `INSERT INTO memory_version (
  version_id, entity_id, seq, valid_from, valid_until, text,
  emo_subject, emo_trigger, emo_label, emo_intensity, emo_confidence,
  source_session_id, source_seq_start, source_seq_end,
  distill_status, distill_model, supersedes, author, device_id, created_at
) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`

export class TemporalTree {
  readonly #db: SqlDriver
  readonly #journal: Journal
  readonly #emotionConfidenceGate: number
  readonly #clock: () => number

  constructor(db: SqlDriver, journal: Journal, options: TemporalTreeOptions = {}) {
    this.#db = db
    this.#journal = journal
    this.#emotionConfidenceGate = options.emotionConfidenceGate ?? 0.6
    this.#clock = options.clock ?? Date.now
  }

  /**
   * 写入一个新版本（PRD 3 的核心入口）。
   *
   * 分支：
   *  A. 无活跃版本            → 直接开新版本，valid_until = NULL。
   *  B. validFrom >= 活跃起点 → 关闭活跃版本（valid_until = validFrom），开新版本。
   *  C. validFrom 落在历史区间 → **切分**：把覆盖该时刻的版本在 validFrom 处切开，
   *     新区间插入新正文。这是"补录历史"能成立的原因，也是多端合并的关键能力。
   *
   * 幂等：若目标区间的正文与待写正文一致，不产生新版本，直接返回既有记录。
   */
  async openVersion(input: OpenVersionInput): Promise<OpenedVersion> {
    assertScope(input.scope, 'TemporalTree.openVersion')
    const text = normalizeText(input.text)
    if (!text) throw new Error('TemporalTree.openVersion: text 不能为空')
    const at = input.validFrom ?? this.#clock()
    if (!Number.isFinite(at) || at <= 0) throw new Error('TemporalTree.openVersion: validFrom 非法')

    const emotion = this.#sanitizeEmotion(input.emotion)
    const author: Author = input.author ?? 'agent'

    // 事务内只碰数据库；journal 一律在提交后写，避免"日志说有、库里没有"。
    const outcome = this.#db.transaction(() => {
      const entity = this.#resolveEntity(input, text, author)
      const result = this.#writeVersion(entity, { text, at, emotion, author, input })
      // 实体冗余字段与活跃正文保持同步，供列表页免 JOIN 展示。
      const active = this.#db.one<VersionRow>(
        `SELECT * FROM memory_version WHERE entity_id = ? AND valid_until IS NULL`,
        [entity.entity_id],
      )
      const canonical = active?.text ?? text
      const salience = input.salience ?? entity.salience
      const trust = input.trust ?? entity.trust
      this.#db.run(
        `UPDATE memory_entity SET canonical = ?, salience = ?, trust = ?, updated_at = ? WHERE entity_id = ?`,
        [canonical, salience, trust, this.#clock(), entity.entity_id],
      )
      const fresh = this.#db.one<EntityRow>(`SELECT * FROM memory_entity WHERE entity_id = ?`, [
        entity.entity_id,
      ])!
      return { entity: fresh, ...result, journalOps: buildJournalOps(fresh, result) }
    })

    // 先落 journal，再返回：调用方 await 完成后，这次记忆已经可以跨设备恢复。
    for (const op of outcome.journalOps) await this.#journal.append(op)
    return {
      entity: outcome.entity,
      version: outcome.version,
      affected: outcome.affected,
      deduped: outcome.deduped,
    }
  }

  /**
   * 关闭某个实体的活跃版本（"这条记忆到此为止"）。
   * 与 `openVersion` 分开，是因为"遗忘/失效"不一定伴随新内容。
   */
  async closeAt(entityId: string, at: number, scope: Scope, author: Author = 'user'): Promise<VersionRow | null> {
    assertScope(scope, 'TemporalTree.closeAt')
    const closed = this.#db.transaction(() => {
      const entity = this.#requireEntity(entityId, scope)
      const active = this.#db.one<VersionRow>(
        `SELECT * FROM memory_version WHERE entity_id = ? AND valid_until IS NULL`,
        [entity.entity_id],
      )
      if (!active) return null
      if (at <= active.valid_from) {
        // 关闭时间不得早于开启时间，否则会产生零长/负长区间。
        throw new Error(`closeAt: ${at} <= valid_from ${active.valid_from}`)
      }
      this.#db.run(`UPDATE memory_version SET valid_until = ? WHERE version_id = ?`, [at, active.version_id])
      this.#db.run(`UPDATE memory_entity SET updated_at = ? WHERE entity_id = ?`, [this.#clock(), entity.entity_id])
      return { ...active, valid_until: at }
    })
    if (closed) {
      await this.#journal.append({
        op: 'version.close',
        entityId,
        versionId: closed.version_id,
        validUntil: closed.valid_until,
        author,
      })
    }
    return closed
  }

  /** 查询某实体在指定时刻的版本（时间旅行读）。 */
  asOf(entityId: string, at: number, scope: Scope): VersionRow | undefined {
    assertScope(scope, 'TemporalTree.asOf')
    return this.#db.one<VersionRow>(
      `SELECT v.* FROM memory_version v
         JOIN memory_entity e ON e.entity_id = v.entity_id
        WHERE v.entity_id = ? AND e.workspace_id = ? AND e.agent_id = ?
          AND v.valid_from <= ? AND (v.valid_until IS NULL OR v.valid_until > ?)
        ORDER BY v.valid_from DESC LIMIT 1`,
      [entityId, scope.workspaceId, scope.agentId, at, at],
    )
  }

  /** 实体完整历史（按时间正序），供回滚面板与审计使用。 */
  history(entityId: string, scope: Scope): VersionRow[] {
    assertScope(scope, 'TemporalTree.history')
    this.#requireEntity(entityId, scope)
    return this.#db.all<VersionRow>(
      `SELECT * FROM memory_version WHERE entity_id = ? ORDER BY valid_from ASC, seq ASC`,
      [entityId],
    )
  }

  // ── 内部实现 ────────────────────────────────────────────────────────────

  /**
   * 解析或创建实体。
   * 身份指纹不含正文：同 subjectKey 的正文变化应当落在版本层，而不是分裂成两个实体。
   */
  #resolveEntity(input: OpenVersionInput, text: string, author: Author): EntityRow {
    const { scope } = input
    if (input.entityId) return this.#requireEntity(input.entityId, scope)

    const contentHash = identityHash({
      workspaceId: scope.workspaceId,
      agentId: scope.agentId,
      kind: input.kind,
      subjectKey: input.subjectKey,
    })
    const existing = this.#db.one<EntityRow>(
      `SELECT * FROM memory_entity
        WHERE workspace_id = ? AND agent_id = ? AND content_hash = ?`,
      [scope.workspaceId, scope.agentId, contentHash],
    )
    if (existing) return existing

    const now = this.#clock()
    const entity: EntityRow = {
      entity_id: newId('ent'),
      workspace_id: scope.workspaceId,
      agent_id: scope.agentId,
      kind: input.kind,
      subject_key: input.subjectKey,
      canonical: text,
      salience: clamp01(input.salience ?? 0.5),
      trust: clamp01(input.trust ?? scope.trust ?? DEFAULT_TRUST[author]),
      status: 'active',
      content_hash: contentHash,
      created_at: now,
      updated_at: now,
      device_id: deviceOf(scope),
    }
    this.#db.run(
      `INSERT INTO memory_entity (
         entity_id, workspace_id, agent_id, kind, subject_key, canonical,
         salience, trust, status, content_hash, created_at, updated_at, device_id
       ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      [
        entity.entity_id,
        entity.workspace_id,
        entity.agent_id,
        entity.kind,
        entity.subject_key,
        entity.canonical,
        entity.salience,
        entity.trust,
        entity.status,
        entity.content_hash,
        entity.created_at,
        entity.updated_at,
        entity.device_id,
      ],
    )
    return entity
  }

  /**
   * 复现确认：同一实体又被写了一次（正文可能一致、也可能是新版本）。
   * 只动计数与 `updated_at`，不动 `created_at` —— 诞生时间是事实，不该被覆盖。
   */
  #reinforce(entityId: string, at: number): void {
    this.#db.run(
      `UPDATE memory_entity
          SET reinforce_count = reinforce_count + 1,
              updated_at = CASE WHEN ? > updated_at THEN ? ELSE updated_at END
        WHERE entity_id = ?`,
      [at, at, entityId],
    )
  }

  /** 事务内的版本写入（分支 A/B/C 都收敛到这里）。 */
  #writeVersion(
    entity: EntityRow,
    ctx: {
      text: string
      at: number
      emotion: EmotionAttribution | null
      author: Author
      input: OpenVersionInput
    },
  ): { version: VersionRow; affected: VersionRow[]; deduped: boolean } {
    const { text, at } = ctx
    const active = this.#db.one<VersionRow>(
      `SELECT * FROM memory_version WHERE entity_id = ? AND valid_until IS NULL`,
      [entity.entity_id],
    )

    // 分支 A：首次写入。
    if (!active) {
      const version = this.#insertVersion(entity, ctx, at, null)
      return { version, affected: [], deduped: false }
    }

    // 幂等：正文一致且落在活跃区间内，不产生新版本。
    // 但"同一句话第二次被说出来"是有信息量的：用户又说了一遍 = 复现确认，
    // 记进 reinforce_count，检索时加权（对齐 graph-memory 的 validated_count）。
    if (active.text === text && at >= active.valid_from) {
      this.#reinforce(entity.entity_id, at)
      return { version: active, affected: [], deduped: true }
    }

    // 分支 B：正常追加（时间单调向前）。
    if (at >= active.valid_from) {
      this.#db.run(`UPDATE memory_version SET valid_until = ? WHERE version_id = ?`, [
        at,
        active.version_id,
      ])
      const closed: VersionRow = { ...active, valid_until: at }
      const version = this.#insertVersion(entity, ctx, at, null)
      return { version, affected: [closed], deduped: false }
    }

    // 分支 C：历史补录 —— 找到覆盖 at 的版本并切分。
    const covering = this.#db.one<VersionRow>(
      `SELECT * FROM memory_version
        WHERE entity_id = ? AND valid_from <= ? AND (valid_until IS NULL OR valid_until > ?)
        ORDER BY valid_from DESC LIMIT 1`,
      [entity.entity_id, at, at],
    )
    if (!covering) {
      // at 早于所有版本：新区间终点 = 最早版本的起点。
      const version = this.#insertVersion(entity, ctx, at, active.valid_from)
      return { version, affected: [], deduped: false }
    }
    if (covering.text === text) {
      this.#reinforce(entity.entity_id, at)
      return { version: covering, affected: [], deduped: true }
    }
    const inheritedUntil = covering.valid_until
    this.#db.run(`UPDATE memory_version SET valid_until = ? WHERE version_id = ?`, [
      at,
      covering.version_id,
    ])
    const truncated: VersionRow = { ...covering, valid_until: at }
    const version = this.#insertVersion(entity, ctx, at, inheritedUntil)
    return { version, affected: [truncated], deduped: false }
  }

  /** 真正的 INSERT，参数顺序与 INSERT_VERSION 严格对应。 */
  #insertVersion(
    entity: EntityRow,
    ctx: {
      text: string
      emotion: EmotionAttribution | null
      author: Author
      input: OpenVersionInput
    },
    validFrom: number,
    validUntil: number | null,
  ): VersionRow {
    const seqRow = this.#db.one<{ n: number }>(
      `SELECT COALESCE(MAX(seq), 0) + 1 AS n FROM memory_version WHERE entity_id = ?`,
      [entity.entity_id],
    )
    const seq = seqRow?.n ?? 1
    const now = this.#clock()
    const version: VersionRow = {
      version_id: newId('ver'),
      entity_id: entity.entity_id,
      seq,
      valid_from: validFrom,
      valid_until: validUntil,
      text: ctx.text,
      emo_subject: ctx.emotion?.subject ?? null,
      emo_trigger: ctx.emotion?.trigger ?? null,
      emo_label: ctx.emotion?.label ?? null,
      emo_intensity: ctx.emotion?.intensity ?? null,
      emo_confidence: ctx.emotion?.confidence ?? null,
      source_session_id: ctx.input.source?.sessionId ?? null,
      source_seq_start: ctx.input.source?.seqStart ?? null,
      source_seq_end: ctx.input.source?.seqEnd ?? null,
      distill_status: ctx.input.distillStatus ?? 'raw',
      distill_model: ctx.input.distillModel ?? null,
      // 普通写入不声明"取代关系"；只有合并/迁移工具才会显式改写该字段。
      supersedes: null,
      author: ctx.author,
      device_id: deviceOf(ctx.input.scope),
      created_at: now,
    }
    this.#db.run(INSERT_VERSION, [
      version.version_id,
      version.entity_id,
      version.seq,
      version.valid_from,
      version.valid_until,
      version.text,
      version.emo_subject,
      version.emo_trigger,
      version.emo_label,
      version.emo_intensity,
      version.emo_confidence,
      version.source_session_id,
      version.source_seq_start,
      version.source_seq_end,
      version.distill_status,
      version.distill_model,
      version.supersedes,
      version.author,
      version.device_id,
      version.created_at,
    ])
    return version
  }

  /** 取实体并校验作用域；跨工作区访问一律抛 ScopeViolation（不是返回空）。 */
  #requireEntity(entityId: string, scope: Scope): EntityRow {
    const row = this.#db.one<EntityRow>(`SELECT * FROM memory_entity WHERE entity_id = ?`, [entityId])
    if (!row) throw new Error(`entity not found: ${entityId}`)
    if (row.workspace_id !== scope.workspaceId || row.agent_id !== scope.agentId) {
      throw new ScopeViolation('entity-out-of-scope', {
        entityId,
        expected: { workspaceId: scope.workspaceId, agentId: scope.agentId },
        actual: { workspaceId: row.workspace_id, agentId: row.agent_id },
      })
    }
    return row
  }

  /**
   * 情感归因闸门（PRD 6）。
   * 任何一项不合格就整块置 null —— 宁可不记情绪，也不要记错情绪。
   */
  #sanitizeEmotion(emotion: EmotionAttribution | null | undefined): EmotionAttribution | null {
    if (!emotion) return null
    const subject = emotion.subject?.trim()
    const trigger = emotion.trigger?.trim()
    if (!subject || !trigger) return null
    if (!EMOTION_LABELS.includes(emotion.label)) return null
    const confidence = clamp01(emotion.confidence)
    if (confidence < this.#emotionConfidenceGate) return null
    return {
      subject,
      trigger,
      label: emotion.label,
      intensity: clamp01(emotion.intensity),
      confidence,
    }
  }
}

/** 文本入库前的最小归一化：NFC + 去首尾空白（保留内部换行，代码片段需要）。 */
function normalizeText(text: string): string {
  return text.normalize('NFC').trim()
}

function clamp01(value: number): number {
  if (!Number.isFinite(value)) return 0
  return Math.min(1, Math.max(0, value))
}

/** 设备标识；未显式提供时用 `local`，保证单机场景也能写入。 */
function deviceOf(scope: Scope): string {
  return scope.deviceId ?? 'local'
}

/** 把一次写入翻译成 journal 记录，顺序即回放顺序。 */
function buildJournalOps(
  entity: EntityRow,
  result: { version: VersionRow; affected: readonly VersionRow[]; deduped: boolean },
): JournalInput[] {
  const ops: JournalInput[] = [
    {
      op: 'entity.upsert',
      entityId: entity.entity_id,
      workspaceId: entity.workspace_id,
      agentId: entity.agent_id,
      kind: entity.kind,
      subjectKey: entity.subject_key,
      canonical: entity.canonical,
      salience: entity.salience,
      trust: entity.trust,
      status: entity.status,
    },
  ]
  if (result.deduped) return ops

  for (const closed of result.affected) {
    ops.push({
      op: 'version.close',
      entityId: entity.entity_id,
      versionId: closed.version_id,
      validUntil: closed.valid_until,
      author: closed.author,
    })
  }
  ops.push({
    op: 'version.open',
    entityId: entity.entity_id,
    versionId: result.version.version_id,
    seq: result.version.seq,
    validFrom: result.version.valid_from,
    validUntil: result.version.valid_until,
    text: result.version.text,
    distillStatus: result.version.distill_status,
    emotion: result.version.emo_label
      ? {
          subject: result.version.emo_subject,
          trigger: result.version.emo_trigger,
          label: result.version.emo_label,
          intensity: result.version.emo_intensity,
          confidence: result.version.emo_confidence,
        }
      : null,
    author: result.version.author,
    deviceId: result.version.device_id,
  })
  return ops
}
