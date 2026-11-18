/**
 * dsh-shared-memories — 踩坑记录四段收敛（PitfallStore）
 * ---------------------------------------------------------------------------
 * PRD 7。一条踩坑记忆的生命周期是**只升不降**的四段：
 *
 *   observation（现象：报了什么错）
 *     → lesson（经验：我学到了什么）
 *       → pattern（模式：这类问题长什么样）
 *         → rule（规则：以后必须怎么做）
 *
 * 前两段可以自动写（模型能确定地说"这个报错是因为 X"）；
 * 后两段**必须用户确认**——`rule` 会进 System Prompt，让 AI 永久改变行为，
 * 这种权力只能由人授予。所以 `requestPromotion()` 只发请求拿 token，
 * `confirm()` 才真正落库。
 */

import type { Journal } from '../../shared/journal.js'
import { newId } from '../../shared/ids.js'
import type { Scope } from '../../shared/scope.js'
import type { SqlDriver } from '../../shared/types.js'

export type PitfallStage = 'observation' | 'lesson' | 'pattern' | 'rule'

export const STAGE_ORDER: readonly PitfallStage[] = ['observation', 'lesson', 'pattern', 'rule']

export interface PitfallRow {
  pitfall_id: string
  workspace_id: string
  agent_id: string
  observation: string
  lesson: string
  pattern: string
  rule: string
  stage: PitfallStage
  confirmed: number
  occurrences: number
  created_at: number
  updated_at: number
}

/** 升格请求：带上 token 与过期时间，防止 UI 上"点了两下"就悄悄改了 system prompt。 */
export interface PromotionRequest {
  readonly requestId: string
  readonly pitfallId: string
  readonly to: PitfallStage
  readonly preview: PromotionPreviewText
  readonly expiresAt: number
}

/** 升格预览：四格都是字符串（库里 NOT NULL DEFAULT ''），UI 直接显示即可。 */
export interface PromotionPreviewText {
  observation: string
  lesson: string
  pattern: string
  rule: string
}

export interface PitfallStoreOptions {
  readonly db: SqlDriver
  readonly journal: Journal
  /** 升格请求有效期，默认 10 分钟。 */
  readonly approvalTtlMs?: number
  readonly clock?: () => number
  readonly onWarn?: (message: string) => void
}

export class PitfallStore {
  readonly #db: SqlDriver
  readonly #journal: Journal
  readonly #ttl: number
  readonly #clock: () => number
  readonly #onWarn: (message: string) => void
  readonly #pending = new Map<string, PromotionRequest>()

  constructor(options: PitfallStoreOptions) {
    this.#db = options.db
    this.#journal = options.journal
    this.#ttl = options.approvalTtlMs ?? 600_000
    this.#clock = options.clock ?? Date.now
    this.#onWarn = options.onWarn ?? (() => {})
  }

  /**
   * 记录一个新坑。同一作用域下现象文本相同 → 只累加 `occurrences`，
   * 不新建行：同一个错误犯十次，应该是一条"顽固坑"，不是十条记忆。
   */
  async record(input: {
    scope: Scope
    observation: string
    lesson?: string
    pattern?: string
    author?: 'user' | 'agent'
  }): Promise<PitfallRow> {
    const now = this.#clock()
    const existing = this.#db.one<PitfallRow>(
      `SELECT * FROM pitfall WHERE workspace_id = ? AND agent_id = ? AND observation = ?`,
      [input.scope.workspaceId, input.scope.agentId, input.observation],
    )
    if (existing) {
      const stage = advanceStage(existing.stage, {
        lesson: input.lesson ?? existing.lesson,
        pattern: input.pattern ?? existing.pattern,
      })
      this.#db.run(
        `UPDATE pitfall SET occurrences = occurrences + 1, updated_at = ?, lesson = ?, pattern = ?, stage = ?
          WHERE pitfall_id = ?`,
        [now, input.lesson ?? existing.lesson, input.pattern ?? existing.pattern, stage, existing.pitfall_id],
      )
      return { ...existing, occurrences: existing.occurrences + 1, stage, updated_at: now }
    }

    const row: PitfallRow = {
      pitfall_id: newId('pit'),
      workspace_id: input.scope.workspaceId,
      agent_id: input.scope.agentId,
      observation: input.observation,
      lesson: input.lesson ?? '',
      pattern: input.pattern ?? '',
      rule: '',
      stage: advanceStage('observation', { lesson: input.lesson, pattern: input.pattern }),
      confirmed: 0,
      occurrences: 1,
      created_at: now,
      updated_at: now,
    }
    this.#db.run(
      `INSERT INTO pitfall (pitfall_id, workspace_id, agent_id, observation, lesson, pattern, rule,
                            stage, confirmed, occurrences, created_at, updated_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
      [
        row.pitfall_id,
        row.workspace_id,
        row.agent_id,
        row.observation,
        row.lesson,
        row.pattern,
        row.rule,
        row.stage,
        row.confirmed,
        row.occurrences,
        row.created_at,
        row.updated_at,
      ],
    )
    return row
  }

  /**
   * 申请升格。`to` 为 `pattern` / `rule` 时必须走确认；`lesson` 可以直接升。
   * 返回的请求带 TTL，过期即作废（`confirm` 会拒绝）。
   */
  requestPromotion(input: {
    scope: Scope
    pitfallId: string
    to: PitfallStage
    patch?: { lesson?: string; pattern?: string; rule?: string }
  }): PromotionRequest {
    const row = this.#db.one<PitfallRow>(
      `SELECT * FROM pitfall WHERE pitfall_id = ? AND workspace_id = ? AND agent_id = ?`,
      [input.pitfallId, input.scope.workspaceId, input.scope.agentId],
    )
    if (!row) throw new PitfallError('pitfall-not-found', `找不到踩坑记录 ${input.pitfallId}`)
    if (STAGE_ORDER.indexOf(input.to) < STAGE_ORDER.indexOf(row.stage)) {
      throw new PitfallError('pitfall-stage-regress', '踩坑记录只能升格，不能降级')
    }
    const patch = input.patch ?? {}
    const preview: PromotionPreviewText = {
      observation: row.observation,
      lesson: patch.lesson ?? row.lesson,
      pattern: patch.pattern ?? row.pattern,
      rule: patch.rule ?? row.rule,
    }
    // 升格目标那一格若是空的，就沿链路往下取最具体的一层：
    // pattern ← lesson ← observation，rule ← pattern ← lesson ← observation。
    // 不这么做的话，`record()` 只填了 lesson 的记录升格成 pattern 后
    // pattern 列仍是 NULL，确认了却永远注入不出去——"点了确认没反应"。
    const column = columnOf(input.to)
    preview[column] = deriveStageText(preview, input.to)

    const request: PromotionRequest = {
      requestId: newId('apr'),
      pitfallId: row.pitfall_id,
      to: input.to,
      preview,
      expiresAt: this.#clock() + this.#ttl,
    }
    this.#pending.set(request.requestId, request)
    return request
  }

  /** 用户点了"确认"：真正落库 + 写 journal（rule 从此进 System Prompt）。 */
  async confirm(requestId: string, by: string, scope: Scope): Promise<PitfallRow> {
    const request = this.#pending.get(requestId)
    if (!request) throw new PitfallError('promotion-not-found', '升格请求不存在或已被消费')
    if (this.#clock() > request.expiresAt) {
      this.#pending.delete(requestId)
      throw new PitfallError('promotion-expired', '升格请求已过期，请重新发起')
    }
    if (request.to === 'rule' && !request.preview.rule.trim()) {
      throw new PitfallError('promotion-empty-rule', '升格为 rule 必须写出具体规则内容')
    }

    const now = this.#clock()
    const confirmed = request.to === 'rule' || request.to === 'pattern' ? 1 : 0
    this.#db.transaction(() => {
      this.#db.run(
        `UPDATE pitfall SET stage = ?, lesson = ?, pattern = ?, rule = ?, confirmed = ?, updated_at = ?
          WHERE pitfall_id = ? AND workspace_id = ? AND agent_id = ?`,
        [
          request.to,
          request.preview.lesson,
          request.preview.pattern,
          request.preview.rule,
          confirmed,
          now,
          request.pitfallId,
          scope.workspaceId,
          scope.agentId,
        ],
      )
      this.#db.run(
        `INSERT INTO audit_log (audit_id, workspace_id, agent_id, action, detail, created_at)
         VALUES (?,?,?,?,?,?)`,
        [
          newId('aud'),
          scope.workspaceId,
          scope.agentId,
          'pitfall.promote',
          JSON.stringify({ pitfallId: request.pitfallId, to: request.to, by }),
          now,
        ],
      )
    })
    this.#pending.delete(requestId)

    await this.#journal.append({
      op: 'pitfall.promote',
      pitfallId: request.pitfallId,
      stage: request.to,
      rule: request.preview.rule,
      workspaceId: scope.workspaceId,
      agentId: scope.agentId,
      by,
      at: now,
    })

    return {
      pitfall_id: request.pitfallId,
      workspace_id: scope.workspaceId,
      agent_id: scope.agentId,
      observation: request.preview.observation,
      lesson: request.preview.lesson,
      pattern: request.preview.pattern,
      rule: request.preview.rule,
      stage: request.to,
      confirmed,
      occurrences: 0,
      created_at: now,
      updated_at: now,
    }
  }

  /** 用户点了"拒绝"：请求作废，记录降回原状（不做任何写库）。 */
  reject(requestId: string): void {
    this.#pending.delete(requestId)
  }

  /** 待确认队列（UI 里那个"规则待确认"角标）。 */
  pending(): PromotionRequest[] {
    const now = this.#clock()
    for (const [id, request] of this.#pending) if (now > request.expiresAt) this.#pending.delete(id)
    return [...this.#pending.values()]
  }

  /**
   * 取用于 System Prompt 注入的规则与模式。
   * 只取 `confirmed = 1` 的——没经过人确认的东西不许站到系统提示里。
   */
  injectable(scope: Scope): { rules: string[]; patterns: string[] } {
    try {
      const rows = this.#db.all<Pick<PitfallRow, 'rule' | 'pattern' | 'stage' | 'confirmed'>>(
        `SELECT rule, pattern, stage, confirmed FROM pitfall
          WHERE workspace_id = ? AND agent_id = ? AND confirmed = 1 AND stage IN ('pattern','rule')
          ORDER BY stage = 'rule' DESC, occurrences DESC, updated_at DESC
          LIMIT 32`,
        [scope.workspaceId, scope.agentId],
      )
      const rules: string[] = []
      const patterns: string[] = []
      for (const row of rows) {
        if (row.stage === 'rule' && row.rule.trim()) rules.push(row.rule.trim())
        else if (row.pattern.trim()) patterns.push(row.pattern.trim())
      }
      return { rules, patterns }
    } catch (error) {
      this.#onWarn(`读取可注入规则失败：${error instanceof Error ? error.message : String(error)}`)
      return { rules: [], patterns: [] }
    }
  }

  list(scope: Scope, limit = 100): PitfallRow[] {
    try {
      return this.#db.all<PitfallRow>(
        `SELECT * FROM pitfall WHERE workspace_id = ? AND agent_id = ?
          ORDER BY updated_at DESC LIMIT ?`,
        [scope.workspaceId, scope.agentId, limit],
      )
    } catch {
      return []
    }
  }

  /**
   * 删除一条踩坑记录（用户手动干涉：删掉记错的观察 / 不再要的规则）。
   *
   * 直接物理删除 + 写审计，不写 journal。理由：`record()` 只 INSERT 库表、
   * 不写 journal（observation 不靠日志回放重建），所以这里删了就不会在冷启动
   * 恢复时被复活；即便之前升格时写过 `pitfall.promote` 日志，回放时也只是
   * UPDATE 一条已不存在的行（0 行、无副作用）。这是最稳的"删了不还魂"。
   */
  remove(pitfallId: string, scope: Scope): { deleted: boolean } {
    const deleted = this.#db.run(
      `DELETE FROM pitfall WHERE pitfall_id = ? AND workspace_id = ? AND agent_id = ?`,
      [pitfallId, scope.workspaceId, scope.agentId],
    ).changes > 0
    if (deleted) {
      this.#db.run(
        `INSERT INTO audit_log (audit_id, workspace_id, agent_id, action, detail, created_at)
         VALUES (?,?,?,?,?,?)`,
        [
          newId('aud'),
          scope.workspaceId,
          scope.agentId,
          'pitfall.remove',
          JSON.stringify({ pitfallId }),
          this.#clock(),
        ],
      )
    }
    return { deleted }
  }
}

export class PitfallError extends Error {
  readonly code: string
  constructor(code: string, message: string) {
    super(message)
    this.name = 'PitfallError'
    this.code = code
  }
}

/** 升格目标对应的列名。 */
function columnOf(to: PitfallStage): 'lesson' | 'pattern' | 'rule' {
  if (to === 'rule') return 'rule'
  if (to === 'pattern') return 'pattern'
  return 'lesson'
}

/**
 * 升格目标那一格为空时，沿链路往下取最具体的一层。
 *
 * `pattern` ← `lesson` ← `observation`：这三层是"描述"，措辞可以沿用。
 * `rule` 例外——**不许继承**。规则是要写进 System Prompt 的命令句，
 * 把一句"agent/created 必须 await"当 rule 用还勉强，把观察当 rule 用就是灾难。
 * 所以 `rule` 必须由人亲手写；空着就让 `confirm()` 直接拒绝。
 */
function deriveStageText(preview: PromotionPreviewText, to: PitfallStage): string {
  const chain =
    to === 'rule'
      ? [preview.rule]
      : to === 'pattern'
        ? [preview.pattern, preview.lesson, preview.observation]
        : [preview.lesson, preview.observation]
  return chain.map((text) => text.trim()).find((text) => text.length > 0) ?? ''
}

/** 有 lesson 就能到 lesson，有 pattern 就能到 pattern；rule 永远要人批。 */
function advanceStage(
  current: PitfallStage,
  patch: { lesson?: string; pattern?: string },
): PitfallStage {
  let stage = current
  if (patch.lesson?.trim() && stage === 'observation') stage = 'lesson'
  if (patch.pattern?.trim() && stage === 'lesson') stage = 'pattern'
  return stage
}
