/**
 * 孤儿作用域归并（`memory:merge-agent`）：把写在会话 id 名下的记忆搬回人格名下。
 *
 * 背景：0.2.2 之前 `DistillService.run()` 用 `identity.resolve()` 纯读解析，遇到
 * "persona_identity 里没有这个会话"时只能原样返回会话 id，于是一批记忆被写在
 * 一次性 agent 名下 —— 用户在 persona 视图里永远看不到它们（落库断层的存量部分）。
 * `#personaOf()` 修好了**新写入**，这个模块负责**旧数据**：
 *
 *   ① 找出所有"有记忆、却没有身份绑定"的 agent_id（真孤儿）；
 *   ② 走 `identity.touch()` 给它们登记：本工作区有活跃人格就继承，否则自立 ——
 *      与运行期写入路径**完全同一套**规则，不做第二套判断；
 *   ③ 解析到不同人格的，把实体、版本、坑、隔离区、技能、策略、审计整条搬过去。
 *
 * 幂等性：跑完孤儿集合为空，第二次跑是 0 改动；任何一次冷启动都会再跑一遍，
 * 所以"journal 重放把它们又变回孤儿"（journal 里记的是旧 agent_id）也能自愈 ——
 * 这就是为什么不改写 journal：真相源保持原样，DB 是派生态，派生态每次收敛。
 */

import { identityHash } from '../../shared/ids.js'
import type { SqlDriver } from '../../shared/types.js'
import type { PersonaIdentityStore } from './persona-identity.js'

export interface MergeAgentTarget {
  readonly from: string
  readonly to: string
  readonly entities: number
  readonly collapsed: number
}

export interface MergeAgentResult {
  /** 发现的孤儿 agent 数。 */
  readonly orphans: number
  /** 真正改写的作用域数（解析结果 === 自己 的不算）。 */
  readonly merged: number
  /** 搬过去的实体数（含并进已有实体的）。 */
  readonly entities: number
  /** 与目标人格已有实体重复、被并掉的实体数。 */
  readonly collapsed: number
  /** 附随表（pitfall / quarantine / skill / policy / audit）改写的行数合计。 */
  readonly rows: number
  readonly targets: readonly MergeAgentTarget[]
}

export interface MergeAgentOptions {
  readonly db: SqlDriver
  readonly identity: PersonaIdentityStore
  readonly clock?: () => number
  readonly onWarn?: (message: string) => void
  /** 只处理某个工作区（缺省 = 库里出现过的全部工作区）。 */
  readonly workspaceId?: string
  /** 演练：只算不动库。排障时先看它要动什么。 */
  readonly dryRun?: boolean
}

interface OrphanRow {
  readonly workspace_id: string
  readonly agent_id: string
  readonly n: number
}

interface EntityRow {
  readonly entity_id: string
  readonly kind: string
  readonly subject_key: string
  readonly content_hash: string
}

interface VersionRow {
  readonly version_id: string
  readonly seq: number
  readonly valid_from: number
  readonly valid_until: number | null
}

/**
 * 归并孤儿作用域。返回真实改动量（不是"影响行数"的估算）。
 *
 * 失败策略：单个孤儿出错只告警并跳过 —— 冷启动路径上，一条脏数据不该让整个插件
 * 起不来；下次启动会再试一次（幂等）。
 */
export async function mergeOrphanAgents(options: MergeAgentOptions): Promise<MergeAgentResult> {
  const { db, identity } = options
  const warn = options.onWarn ?? (() => undefined)
  const at = (options.clock ?? (() => Date.now()))()
  const dryRun = options.dryRun === true

  const targets: MergeAgentTarget[] = []
  let entities = 0
  let collapsed = 0
  let rows = 0

  const orphans = findOrphans(db, options.workspaceId)
  for (const orphan of orphans) {
    let personaId = orphan.agent_id
    try {
      // 演练走 preview（零副作用），真跑走 touch（登记 + 继承）。
      // 用 touch 做演练会顺手写出 persona_identity 行——"只报数字"就成了谎话。
      personaId = dryRun
        ? identity.preview(orphan.agent_id, orphan.workspace_id)
        : await identity.touch(orphan.agent_id, orphan.workspace_id)
    } catch (cause) {
      warn(`孤儿归并：登记 ${orphan.agent_id} 失败，跳过（${cause instanceof Error ? cause.message : String(cause)}）`)
      continue
    }
    if (personaId === orphan.agent_id) continue

    try {
      const moved = dryRun
        ? previewMerge(db, orphan.workspace_id, orphan.agent_id, personaId, at)
        : applyMerge(db, orphan.workspace_id, orphan.agent_id, personaId, at)
      entities += moved.entities
      collapsed += moved.collapsed
      rows += moved.rows
      targets.push({ from: orphan.agent_id, to: personaId, entities: moved.entities, collapsed: moved.collapsed })
    } catch (cause) {
      warn(`孤儿归并失败（${orphan.agent_id} → ${personaId}）：${cause instanceof Error ? cause.message : String(cause)}`)
    }
  }

  return { orphans: orphans.length, merged: targets.length, entities, collapsed, rows, targets }
}

/** 有记忆、但没有身份绑定的 agent（= 只读解析会原样返回会话 id 的那些）。 */
export function findOrphans(db: SqlDriver, workspaceId?: string): OrphanRow[] {
  const where = workspaceId === undefined ? '' : 'AND e.workspace_id = ?'
  const params = workspaceId === undefined ? [] : [workspaceId]
  return db.all<OrphanRow>(
    `SELECT e.workspace_id AS workspace_id, e.agent_id AS agent_id, COUNT(*) AS n
       FROM memory_entity e
      WHERE NOT EXISTS (
              SELECT 1 FROM persona_identity p
               WHERE p.agent_id = e.agent_id AND p.workspace_id = e.workspace_id)
        ${where}
      GROUP BY e.workspace_id, e.agent_id
      ORDER BY n DESC`,
    params,
  )
}

interface Moved {
  readonly entities: number
  readonly collapsed: number
  readonly rows: number
}

/** 演练：只数不改。用于排障与测试断言（库必须一字未动）。 */
function previewMerge(db: SqlDriver, workspaceId: string, from: string, to: string, at: number): Moved {
  void at
  const list = db.all<EntityRow>(
    'SELECT entity_id, kind, subject_key, content_hash FROM memory_entity WHERE workspace_id = ? AND agent_id = ?',
    [workspaceId, from],
  )
  let collapsed = 0
  for (const entity of list) {
    const hash = identityHash({ workspaceId, agentId: to, kind: entity.kind, subjectKey: entity.subject_key })
    if (db.one<{ entity_id: string }>('SELECT entity_id FROM memory_entity WHERE workspace_id = ? AND agent_id = ? AND content_hash = ?', [workspaceId, to, hash])) {
      collapsed++
    }
  }
  return { entities: list.length, collapsed, rows: 0 }
}

function applyMerge(db: SqlDriver, workspaceId: string, from: string, to: string, at: number): Moved {
  const list = db.all<EntityRow>(
    'SELECT entity_id, kind, subject_key, content_hash FROM memory_entity WHERE workspace_id = ? AND agent_id = ?',
    [workspaceId, from],
  )
  let collapsed = 0
  let rows = 0

  db.transaction(() => {
    for (const entity of list) {
      const hash = identityHash({ workspaceId, agentId: to, kind: entity.kind, subjectKey: entity.subject_key })
      const existing = db.one<EntityRow>(
        'SELECT entity_id, kind, subject_key, content_hash FROM memory_entity WHERE workspace_id = ? AND agent_id = ? AND content_hash = ?',
        [workspaceId, to, hash],
      )
      if (existing === undefined) {
        // 目标人格没有同身份实体：直接改归属 + 重算指纹（指纹含 agent，必须重算）。
        db.run('UPDATE memory_entity SET agent_id = ?, content_hash = ?, updated_at = ? WHERE entity_id = ?', [
          to,
          hash,
          at,
          entity.entity_id,
        ])
        continue
      }
      // 两边都说过同一件事：把版本并到目标实体上，保住时间树（先关旧、再开新）。
      collapsed++
      const active = db.one<VersionRow>(
        'SELECT version_id, seq, valid_from, valid_until FROM memory_version WHERE entity_id = ? AND valid_until IS NULL',
        [entity.entity_id],
      )
      const targetActive = db.one<VersionRow>(
        'SELECT version_id, seq, valid_from, valid_until FROM memory_version WHERE entity_id = ? AND valid_until IS NULL',
        [existing.entity_id],
      )
      const nextSeq = (db.one<{ n?: number }>('SELECT MAX(seq) AS n FROM memory_version WHERE entity_id = ?', [existing.entity_id])?.n ?? 0) + 1
      if (active && targetActive) {
        if (active.valid_from >= targetActive.valid_from) {
          // 孤儿那条更新：关掉目标的活动版本，让孤儿这条接上去（语义不变，仍是"最新真相"）。
          db.run('UPDATE memory_version SET valid_until = ? WHERE version_id = ?', [active.valid_from, targetActive.version_id])
        } else {
          // 孤儿那条更旧：它只能作为历史，关在目标活动版本开始的那一刻。
          db.run('UPDATE memory_version SET valid_until = ? WHERE version_id = ?', [targetActive.valid_from, active.version_id])
        }
      }
      db.run('UPDATE memory_version SET entity_id = ?, seq = ? WHERE entity_id = ?', [existing.entity_id, nextSeq, entity.entity_id])
      db.run('DELETE FROM memory_entity WHERE entity_id = ?', [entity.entity_id])
    }

    // 附随表：作用域跟着人走。UNIQUE 冲突用 OR IGNORE（目标已经有的就不重复挂）。
    for (const sql of [
      'UPDATE OR IGNORE pitfall SET agent_id = ? WHERE workspace_id = ? AND agent_id = ?',
      'UPDATE OR IGNORE quarantine SET agent_id = ? WHERE workspace_id = ? AND agent_id = ?',
      'UPDATE OR IGNORE agent_skill SET agent_id = ? WHERE workspace_id = ? AND agent_id = ?',
      'UPDATE OR IGNORE session_policy SET agent_id = ? WHERE workspace_id = ? AND agent_id = ?',
      'UPDATE OR IGNORE audit_log SET agent_id = ? WHERE workspace_id = ? AND agent_id = ?',
    ]) {
      rows += runCount(db, sql, [to, workspaceId, from])
    }

    // persona_state：目标已有画像就保留（那是用户真正在用的），没有才接管孤儿那份。
    const mine = db.one<{ agent_id: string }>('SELECT agent_id FROM persona_state WHERE workspace_id = ? AND agent_id = ?', [workspaceId, from])
    if (mine) {
      const theirs = db.one<{ agent_id: string }>('SELECT agent_id FROM persona_state WHERE workspace_id = ? AND agent_id = ?', [workspaceId, to])
      if (theirs) db.run('DELETE FROM persona_state WHERE workspace_id = ? AND agent_id = ?', [workspaceId, from])
      else db.run('UPDATE persona_state SET agent_id = ? WHERE workspace_id = ? AND agent_id = ?', [to, workspaceId, from])
      rows++
    }
  })

  return { entities: list.length, collapsed, rows }
}

/** UPDATE 的影响行数不可靠时不能瞎报：先数一遍再改。 */
function runCount(db: SqlDriver, sql: string, params: readonly unknown[]): number {
  const select = sql
    .replace(/^UPDATE OR IGNORE /, 'SELECT 1 AS x FROM ')
    .replace(/ SET .*? WHERE /, ' WHERE ')
  try {
    const n = db.all<Record<string, unknown>>(select, params).length
    if (n > 0) db.run(sql, params)
    return n
  } catch {
    try {
      db.run(sql, params)
    } catch {
      /* 冲突时 OR IGNORE 已经兜住，这里只可能是表不存在（老库）——忽略 */
    }
    return 0
  }
}
