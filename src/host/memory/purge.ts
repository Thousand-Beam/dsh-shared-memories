/**
 * 彻底销毁（Hard Delete）：把一个人从"数据库 + 事件日志"里同时抹掉。
 *
 * 为什么不能只删库表：
 *   journal 是真相源。下次冷启动 replay 会把删掉的记忆**原样重建**回来，
 *   于是"我删了它"变成"我删了，它还在"。所以销毁必须两件事一起做：
 *
 *   ① 删库：memory_entity / version / emotion / quarantine / persona_state /
 *      persona_identity / agent_skill / session_policy / audit_log 里该 Agent 的行；
 *   ② 改写 journal：把每个 `journal/devices/<device>/*.jsonl` 里属于该 Agent 的
 *      记录**物理剔除**（不是追加删除标记），再追加一条 `agent.purge` 墓碑，
 *      保证"更早的、还留在别的设备上的快照"在 replay 时也会被清掉。
 *
 * 这台机器上没有幽灵副本：文件被原地重写（先写 .tmp 再 rename），
 * 删完 `git grep` 也搜不到原文。
 */

import { readFile, readdir, rename, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

import type { SqlDriver } from '../../shared/types.js'

export interface PurgeResult {
  readonly agentId: string
  readonly entities: number
  readonly versions: number
  readonly quarantine: number
  readonly personas: number
  readonly identities: number
  readonly skills: number
  readonly policies: number
  readonly audits: number
  /** 被改写过的 journal 文件数（含墓碑写入的那个）。 */
  readonly journals: number
  /** 从 journal 里物理剔除的记录条数。 */
  readonly records: number
}

export interface PurgeOptions {
  readonly db: SqlDriver
  readonly root: string
  readonly workspaceId: string
  readonly agentId: string
  readonly clock?: () => number
  readonly onWarn?: (message: string) => void
}

interface JournalRecordShape {
  readonly seq?: number
  readonly op?: string
  readonly workspaceId?: string
  readonly agentId?: string
  readonly [key: string]: unknown
}

/** 物理销毁：库 + journal 一起清。返回真实删除的行数（不是"影响行数"的估算）。 */
export async function purgeAgent(options: PurgeOptions): Promise<PurgeResult> {
  const { db, root, workspaceId, agentId } = options
  const warn = options.onWarn ?? (() => undefined)
  const at = (options.clock ?? (() => Date.now()))()

  const count = (sql: string): number => db.all<{ n?: number }>(sql, [workspaceId, agentId]).length

  // ── ① 删库：先取实体 id（版本表没有 workspace/agent 列，只能按 entity 删） ──
  const entities = db.all<{ entity_id: string }>(
    'SELECT entity_id FROM memory_entity WHERE workspace_id = ? AND agent_id = ?',
    [workspaceId, agentId],
  )
  const versions = countRows(
    db,
    'SELECT version_id FROM memory_version WHERE entity_id IN (SELECT entity_id FROM memory_entity WHERE workspace_id = ? AND agent_id = ?)',
    [workspaceId, agentId],
  )
  const quarantine = countRows(db, 'SELECT quarantine_id FROM quarantine WHERE workspace_id = ? AND agent_id = ?', [workspaceId, agentId])
  const personas = countRows(db, 'SELECT agent_id FROM persona_state WHERE workspace_id = ? AND agent_id = ?', [workspaceId, agentId])
  const identities = countRows(db, 'SELECT agent_id FROM persona_identity WHERE workspace_id = ? AND agent_id = ?', [workspaceId, agentId])
  const skills = countRows(db, 'SELECT skill_id FROM agent_skill WHERE workspace_id = ? AND agent_id = ?', [workspaceId, agentId])
  const policies = countRows(db, 'SELECT session_id FROM session_policy WHERE workspace_id = ? AND agent_id = ?', [workspaceId, agentId])
  const audits = countRows(db, 'SELECT audit_id FROM audit_log WHERE workspace_id = ? AND agent_id = ?', [workspaceId, agentId])

  const tx = (): void => {
    for (const entity of entities) {
      db.run('DELETE FROM memory_version WHERE entity_id = ?', [entity.entity_id])
    }
    db.run('DELETE FROM memory_entity WHERE workspace_id = ? AND agent_id = ?', [workspaceId, agentId])
    db.run('DELETE FROM pitfall WHERE workspace_id = ? AND agent_id = ?', [workspaceId, agentId])
    db.run('DELETE FROM quarantine WHERE workspace_id = ? AND agent_id = ?', [workspaceId, agentId])
    db.run('DELETE FROM persona_state WHERE workspace_id = ? AND agent_id = ?', [workspaceId, agentId])
    db.run('DELETE FROM persona_identity WHERE workspace_id = ? AND agent_id = ?', [workspaceId, agentId])
    // 别的会话可能绑到这个人格上：一并解绑，否则"销毁了还继承"。
    db.run('DELETE FROM persona_identity WHERE workspace_id = ? AND persona_id = ?', [workspaceId, agentId])
    db.run('DELETE FROM agent_skill WHERE workspace_id = ? AND agent_id = ?', [workspaceId, agentId])
    // 提炼水位也一起烧掉：留着会让"销毁后重开同名会话"以为已经记过了。
    db.run(
      'DELETE FROM distill_cursor WHERE session_id IN (SELECT session_id FROM session_policy WHERE workspace_id = ? AND agent_id = ?)',
      [workspaceId, agentId],
    )
    db.run('DELETE FROM session_policy WHERE workspace_id = ? AND agent_id = ?', [workspaceId, agentId])
    db.run('DELETE FROM audit_log WHERE workspace_id = ? AND agent_id = ?', [workspaceId, agentId])
  }
  db.transaction(tx)

  // ── ② 改写 journal：物理剔除 + 墓碑 ──
  const purged = await purgeJournal({
    root,
    workspaceId,
    agentId,
    // 只按 agentId 过滤是不够的：version.open / version.close 只带 entityId。
    entityIds: new Set(entities.map((row) => row.entity_id)),
    at,
    warn,
  })

  return {
    agentId,
    entities: entities.length,
    versions,
    quarantine,
    personas,
    identities,
    skills,
    policies,
    audits,
    journals: purged.files,
    records: purged.records,
  }
}

function countRows(db: SqlDriver, sql: string, params: readonly unknown[]): number {
  try {
    return db.all<Record<string, unknown>>(sql, params).length
  } catch {
    return 0
  }
}

interface PurgeJournalOptions {
  readonly root: string
  readonly workspaceId: string
  readonly agentId: string
  /**
   * 这个人格名下所有实体 id。
   *
   * 为什么不能只按 agentId 过滤：`version.open` / `version.close` 这两类记录
   * 属于实体而不是某次操作，**只带 entityId、不带 agentId**（见
   * `src/host/memory/timetree.ts` 的 `buildJournalOps`）。少了这一条，
   * 库里删干净了、journal 里还留着正文，下次 replay 全部回来。
   */
  readonly entityIds: ReadonlySet<string>
  readonly at: number
  readonly warn: (message: string) => void
}

/** 逐文件剔除属于该 Agent 的记录，最后追加墓碑（墓碑也写进当天文件）。 */
async function purgeJournal(options: PurgeJournalOptions): Promise<{ files: number; records: number }> {
  const { root, workspaceId, agentId, entityIds, at, warn } = options
  const devicesDir = join(root, 'journal', 'devices')
  let devices: string[]
  try {
    devices = await readdir(devicesDir)
  } catch {
    return { files: 0, records: 0 }
  }

  let files = 0
  let records = 0
  for (const device of devices) {
    const dir = join(devicesDir, device)
    let names: string[]
    try {
      names = (await readdir(dir)).filter((name) => name.endsWith('.jsonl'))
    } catch {
      continue
    }
    for (const name of names) {
      const file = join(dir, name)
      let raw: string
      try {
        raw = await readFile(file, 'utf8')
      } catch (cause) {
        warn(`读 journal 失败，跳过 ${name}：${cause instanceof Error ? cause.message : String(cause)}`)
        continue
      }
      const lines = raw.split('\n').filter((line) => line.trim() !== '')
      const kept: string[] = []
      let removed = 0
      for (const line of lines) {
        let record: JournalRecordShape
        try {
          record = JSON.parse(line) as JournalRecordShape
        } catch {
          kept.push(line)
          continue
        }
        const mineByAgent =
          record.agentId === agentId && (record.workspaceId === undefined || record.workspaceId === workspaceId)
        const mineByEntity = typeof record.entityId === 'string' && entityIds.has(record.entityId)
        if (mineByAgent || mineByEntity) {
          removed++
          continue
        }
        kept.push(line)
      }
      if (removed === 0) continue
      const tmp = `${file}.tmp`
      await writeFile(tmp, kept.map((line) => `${line}\n`).join(''), 'utf8')
      await rename(tmp, file)
      files++
      records += removed
    }
  }

  // 墓碑：别的设备上的旧快照 replay 时看到它，会把该 Agent 的行一起清掉。
  const today = new Date(at).toISOString().slice(0, 10)
  const tombstoneFile = join(devicesDir, 'purge', `${today}.jsonl`)
  const tombstone = JSON.stringify({
    seq: 0,
    op: 'agent.purge',
    workspaceId,
    agentId,
    at,
    deviceId: 'purge',
  })
  try {
    const { mkdir } = await import('node:fs/promises')
    await mkdir(join(devicesDir, 'purge'), { recursive: true })
    let existing = ''
    try {
      existing = await readFile(tombstoneFile, 'utf8')
    } catch {
      existing = ''
    }
    const sep = existing === '' || existing.endsWith('\n') ? '' : '\n'
    await writeFile(tombstoneFile, `${existing}${sep}${tombstone}\n`, 'utf8')
    files++
  } catch (cause) {
    warn(`写墓碑失败（旧快照可能把数据带回）：${cause instanceof Error ? cause.message : String(cause)}`)
  }

  return { files, records }
}
