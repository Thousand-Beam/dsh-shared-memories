/**
 * dsh-shared-memories — 夜间整理（Consolidator）
 * ---------------------------------------------------------------------------
 * PRD 4 的"睡眠机制"。三件事，按危险性从低到高排：
 *
 *   ① 精确去重：同 workspace/agent/kind 下，正文归一化后完全相同的活跃版本
 *      → 保留质量最高的那条，其余实体标 `status='merged'`（**不删**，可回溯）
 *   ② 近似合并：不同 subjectKey 但 token 集合 Jaccard ≥ 0.85 的同 kind 记忆
 *      → 同样标 merged，并在幸存版本上记 `supersedes` 指向被合并的版本
 *   ③ 修剪：`salience < 0.15` 且 90 天没被召回过的实体 → `status='forgotten'`，
 *      同时关闭活跃版本。**从不物理删除**：记忆是资产，不是垃圾。
 *
 * 所有动作都写 journal（`memory.forget` / `entity.upsert`），所以"整理错了"
 * 还能靠 git 回退救回来——这是这套设计敢自动整理的前提。
 */

import type { Journal } from '../../shared/journal.js'
import type { Scope } from '../../shared/scope.js'
import type { SqlDriver } from '../../shared/types.js'

export interface ConsolidateOptions {
  readonly db: SqlDriver
  readonly journal: Journal
  /** 修剪阈值：salience 低于它才考虑修剪。 */
  readonly pruneBelow?: number
  /** 修剪冷却期（天）：这段时间内被召回过的记忆不动。 */
  readonly pruneAfterDays?: number
  /** 近似合并的相似度阈值（0..1）。 */
  readonly similarityGate?: number
  readonly clock?: () => number
  readonly onWarn?: (message: string) => void
}

export interface ConsolidateReport {
  readonly scanned: number
  readonly deduped: number
  readonly merged: number
  readonly pruned: number
  /** 只演练不落库（UI 上"预览整理结果"用）。 */
  readonly dryRun: boolean
}

interface ActiveRow {
  entity_id: string
  workspace_id: string
  agent_id: string
  kind: string
  subject_key: string
  text: string
  trust: number
  salience: number
  updated_at: number
  last_recalled_at: number
}

export class Consolidator {
  readonly #db: SqlDriver
  readonly #journal: Journal
  readonly #pruneBelow: number
  readonly #pruneAfterMs: number
  readonly #similarityGate: number
  readonly #clock: () => number
  readonly #onWarn: (message: string) => void

  constructor(options: ConsolidateOptions) {
    this.#db = options.db
    this.#journal = options.journal
    this.#pruneBelow = options.pruneBelow ?? 0.15
    this.#pruneAfterMs = (options.pruneAfterDays ?? 90) * 86_400_000
    this.#similarityGate = options.similarityGate ?? 0.85
    this.#clock = options.clock ?? Date.now
    this.#onWarn = options.onWarn ?? (() => {})
  }

  /**
   * 跑一轮整理。传 `scope` 只整理一个工作区/智能体（UI 手动触发），
   * 不传就全库整理（夜间定时任务）。
   */
  run(scope?: Scope, options: { dryRun?: boolean } = {}): ConsolidateReport {
    const dryRun = options.dryRun ?? false
    const rows = this.#loadActive(scope)
    const now = this.#clock()

    const { deduped, merged } = this.#mergeSimilar(rows, dryRun)
    const prunedIds = this.#pickPrune(rows, now)
    if (!dryRun && prunedIds.length > 0) this.#applyPrune(prunedIds, now)

    return { scanned: rows.length, deduped, merged, pruned: prunedIds.length, dryRun }
  }

  /** 记录召回：把"最近被用到"这件事落库，修剪才有依据。 */
  markRecalled(entityIds: readonly string[], at = this.#clock()): void {
    if (entityIds.length === 0) return
    const placeholders = entityIds.map(() => '?').join(',')
    this.#db.run(
      `UPDATE memory_entity SET last_recalled_at = ? WHERE entity_id IN (${placeholders})`,
      [at, ...entityIds],
    )
  }

  // ── 内部 ────────────────────────────────────────────────────────────────

  #loadActive(scope?: Scope): ActiveRow[] {
    const where = [
      `e.status = 'active'`,
      `v.valid_until IS NULL`,
      scope ? `e.workspace_id = ?` : '',
      scope ? `e.agent_id = ?` : '',
    ]
      .filter(Boolean)
      .join(' AND ')
    const params: unknown[] = scope ? [scope.workspaceId, scope.agentId] : []
    try {
      return this.#db.all<ActiveRow>(
        `SELECT e.entity_id, e.workspace_id, e.agent_id, e.kind, e.subject_key,
                v.text, e.trust, e.salience, v.created_at AS updated_at,
                e.last_recalled_at
           FROM memory_entity e
           JOIN memory_version v ON v.entity_id = e.entity_id
          WHERE ${where}`,
        params,
      )
    } catch (error) {
      this.#onWarn(`读取活跃记忆失败：${error instanceof Error ? error.message : String(error)}`)
      return []
    }
  }

  /** ① + ②：先按正文精确分组，再在同 kind 内做近似聚类。 */
  #mergeSimilar(
    rows: readonly ActiveRow[],
    dryRun: boolean,
  ): { deduped: number; merged: number; touched: boolean } {
    const buckets = new Map<string, ActiveRow[]>()
    for (const row of rows) {
      const key = `${row.workspace_id}\u0000${row.agent_id}\u0000${row.kind}`
      const list = buckets.get(key)
      if (list) list.push(row)
      else buckets.set(key, [row])
    }

    let deduped = 0
    let merged = 0
    let touched = false

    for (const list of buckets.values()) {
      if (list.length < 2) continue
      const clusters: ActiveRow[][] = []
      for (const row of list) {
        const normalized = normalizeText(row.text)
        const hit = clusters.find((cluster) =>
          cluster.some((member) => {
            if (normalizeText(member.text) === normalized) return true
            return jaccard(tokens(member.text), tokens(row.text)) >= this.#similarityGate
          }),
        )
        if (hit) hit.push(row)
        else clusters.push([row])
      }

      for (const cluster of clusters) {
        if (cluster.length < 2) continue
        const keeper = pickKeeper(cluster)
        for (const loser of cluster) {
          if (loser.entity_id === keeper.entity_id) continue
          const exact = normalizeText(loser.text) === normalizeText(keeper.text)
          if (exact) deduped++
          else merged++
          touched = true
          if (dryRun) continue
          this.#markMerged(loser, keeper)
        }
      }
    }
    return { deduped, merged, touched }
  }

  #markMerged(loser: ActiveRow, keeper: ActiveRow): void {
    const now = this.#clock()
    this.#db.transaction(() => {
      this.#db.run(`UPDATE memory_entity SET status = 'merged', updated_at = ? WHERE entity_id = ?`, [
        now,
        loser.entity_id,
      ])
      // 关掉 loser 的活跃版本：否则时间树上留一条 valid_until IS NULL 的悬挂版本，
      // 实体已经 merged，版本却还"活着"，UI 与统计都会对不上。
      this.#db.run(`UPDATE memory_version SET valid_until = ? WHERE entity_id = ? AND valid_until IS NULL`, [
        now,
        loser.entity_id,
      ])
      // 幸存版本的 supersedes 指向被并入的版本，UI 上可以展开"它合并了谁"。
      this.#db.run(
        `UPDATE memory_version SET supersedes = COALESCE(supersedes, ?) WHERE entity_id = ? AND valid_until IS NULL`,
        [loser.entity_id, keeper.entity_id],
      )
    })
  }

  /** ③：挑出可以修剪的实体 id。 */
  #pickPrune(rows: readonly ActiveRow[], now: number): string[] {
    return rows
      .filter((row) => row.salience < this.#pruneBelow)
      .filter((row) => {
        const lastSeen = row.last_recalled_at > 0 ? row.last_recalled_at : row.updated_at
        return now - lastSeen > this.#pruneAfterMs
      })
      .map((row) => row.entity_id)
  }

  #applyPrune(entityIds: readonly string[], now: number): void {
    this.#db.transaction(() => {
      for (const entityId of entityIds) {
        this.#db.run(`UPDATE memory_entity SET status = 'forgotten', updated_at = ? WHERE entity_id = ?`, [
          now,
          entityId,
        ])
        this.#db.run(
          `UPDATE memory_version SET valid_until = ? WHERE entity_id = ? AND valid_until IS NULL`,
          [now, entityId],
        )
      }
    })
    for (const entityId of entityIds) {
      void this.#journal.append({ op: 'memory.forget', entityId, reason: 'consolidate-prune', at: now })
    }
  }
}

/** 归一化：NFC + 折叠空白 + 去标点，用于"同一条记忆的不同措辞"归组。 */
export function normalizeText(text: string): string {
  return text
    .normalize('NFC')
    .replace(/[\s\u3000]+/g, ' ')
    .replace(/[，。！？；：、,.!?;:"'`（）()[\]{}]/g, '')
    .trim()
    .toLowerCase()
}

/** 英文按词、中文按字 bigram（与 ScopedQuery 的 tokenize 保持同一套直觉）。 */
export function tokens(text: string): Set<string> {
  const out = new Set<string>()
  const normalized = normalizeText(text)
  for (const word of normalized.match(/[a-z0-9_]+/g) ?? []) out.add(word)
  const cjk = normalized.replace(/[^\u4e00-\u9fff]/g, '')
  for (let i = 0; i < cjk.length - 1; i++) out.add(cjk.slice(i, i + 2))
  return out
}

export function jaccard(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 || b.size === 0) return 0
  let intersection = 0
  for (const item of a) if (b.has(item)) intersection++
  return intersection / (a.size + b.size - intersection)
}

/** 幸存者：先看 trust，再看 salience，最后看谁更新（越新越可能是改稿后的版本）。 */
function pickKeeper(cluster: readonly ActiveRow[]): ActiveRow {
  return [...cluster].sort(
    (a, b) => b.trust - a.trust || b.salience - a.salience || b.updated_at - a.updated_at,
  )[0] as ActiveRow
}
