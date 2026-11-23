/**
 * 夜间整理（Consolidator）的行为测试
 * ---------------------------------------------------------------------------
 * 三个断言点，对应三件危险的事：
 *   1. 同文重复 → 只留一条，其余标 merged（**不是删除**：删了就没法回溯）
 *   2. 近似重复（Jaccard ≥ 阈值）→ 同样合并，且幸存者的 supersedes 指向被并入者
 *   3. 低权重 + 长期未召回 → forgotten，并且活跃版本被关闭（时间树不能留"永远有效"的尸体）
 *
 * 另外单独验 dryRun：预览一次不能改任何一行数据——UI 上"预览整理结果"就靠它。
 */

import assert from 'node:assert/strict'
import { test } from 'node:test'
import { Consolidator } from '../src/host/memory/consolidate.js'
import { Journal } from '../src/shared/journal.js'
import { openTestDb, tempRoot } from './helpers/db.js'

const WS = 'ws-consolidate'
const AGENT = 'lead'
const DAY = 86_400_000

async function seed(
  db: NonNullable<Awaited<ReturnType<typeof openTestDb>>>,
  rows: readonly {
    id: string
    kind: string
    subject: string
    text: string
    salience?: number
    trust?: number
    updatedAt?: number
    lastRecalledAt?: number
  }[],
): Promise<void> {
  for (const row of rows) {
    const at = row.updatedAt ?? Date.now()
    db.run(
      `INSERT INTO memory_entity (entity_id, workspace_id, agent_id, kind, subject_key, canonical,
        salience, trust, status, content_hash, created_at, updated_at, device_id, last_recalled_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      [
        row.id,
        WS,
        AGENT,
        row.kind,
        row.subject,
        row.subject,
        row.salience ?? 0.6,
        row.trust ?? 0.6,
        'active',
        `hash-${row.id}`,
        at,
        at,
        'dev-a',
        row.lastRecalledAt ?? at,
      ],
    )
    db.run(
      `INSERT INTO memory_version (version_id, entity_id, seq, valid_from, valid_until, text,
        emo_subject, emo_trigger, emo_label, emo_intensity, emo_confidence,
        source_session_id, source_seq_start, source_seq_end, distill_status, distill_model,
        supersedes, author, device_id, created_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      [`ver-${row.id}`, row.id, 1, at, null, row.text, '', '', 'neutral', 0.2, 0.9, '', 0, 0, 'raw', '', null, 'user', 'dev-a', at],
    )
  }
}

test('同文重复只留一条，其余标 merged 而不是删掉', async (t) => {
  const db = await openTestDb(t)
  if (!db) return
  const root = await tempRoot(t)
  const journal = new Journal({ root, deviceId: 'dev-a' })
  await journal.open()

  await seed(db, [
    { id: 'e1', kind: 'fact', subject: 'project.lang', text: '这个项目用 TypeScript 写。', trust: 0.9 },
    { id: 'e2', kind: 'fact', subject: 'project.lang2', text: '这个项目用  TypeScript 写', trust: 0.5 },
    { id: 'e3', kind: 'fact', subject: 'project.db', text: '数据库用 SQLite 物化视图。' },
  ])

  const report = new Consolidator({ db, journal }).run({ workspaceId: WS, agentId: AGENT })

  assert.equal(report.deduped + report.merged, 1, '应该只合并掉一条')
  const statuses = db.all<{ entity_id: string; status: string }>(
    `SELECT entity_id, status FROM memory_entity ORDER BY entity_id`,
  )
  const byId = Object.fromEntries(statuses.map((row) => [row.entity_id, row.status]))
  // trust 高的那条留下（0.9 vs 0.5），另一条被并入。
  assert.equal(byId.e1, 'active')
  assert.equal(byId.e2, 'merged')
  assert.equal(byId.e3, 'active', '不相干的记忆绝不能被顺手合并')

  // 幸存者要能说清"我合并了谁"
  const keeper = db.one<{ supersedes: string | null }>(
    `SELECT supersedes FROM memory_version WHERE entity_id = 'e1' AND valid_until IS NULL`,
  )
  assert.equal(keeper?.supersedes, 'e2')
})

test('低权重且长期未召回的实体被 forgotten，活跃版本同时关闭', async (t) => {
  const db = await openTestDb(t)
  if (!db) return
  const root = await tempRoot(t)
  const journal = new Journal({ root, deviceId: 'dev-a' })
  await journal.open()

  const old = Date.now() - 120 * DAY
  await seed(db, [
    { id: 'faded', kind: 'episode', subject: 'one-off', text: '很久以前的一次无意义寒暄。', salience: 0.05, updatedAt: old, lastRecalledAt: old },
    { id: 'fresh', kind: 'fact', subject: 'keep', text: '仍然重要的结论。', salience: 0.9 },
  ])

  const report = new Consolidator({ db, journal }).run({ workspaceId: WS, agentId: AGENT })
  assert.equal(report.pruned, 1)

  const faded = db.one<{ status: string }>(`SELECT status FROM memory_entity WHERE entity_id = 'faded'`)
  assert.equal(faded?.status, 'forgotten')
  const active = db.one<{ valid_until: number | null }>(
    `SELECT valid_until FROM memory_version WHERE entity_id = 'faded' AND valid_until IS NULL`,
  )
  assert.equal(active, undefined, '忘了就要关版本，不能留一条"永远有效"的记录')

  const fresh = db.one<{ status: string }>(`SELECT status FROM memory_entity WHERE entity_id = 'fresh'`)
  assert.equal(fresh?.status, 'active')
})

test('dryRun 只出报告，一行都不改', async (t) => {
  const db = await openTestDb(t)
  if (!db) return
  const root = await tempRoot(t)
  const journal = new Journal({ root, deviceId: 'dev-a' })
  await journal.open()

  await seed(db, [
    { id: 'd1', kind: 'fact', subject: 'a', text: '同一句话' },
    { id: 'd2', kind: 'fact', subject: 'b', text: '同一句话' },
  ])

  const report = new Consolidator({ db, journal }).run({ workspaceId: WS, agentId: AGENT }, { dryRun: true })
  assert.equal(report.dryRun, true)
  assert.ok(report.deduped + report.merged >= 1, '预览也要算出"本来会合并几条"')

  const untouched = db.all<{ status: string }>(`SELECT status FROM memory_entity`)
  assert.deepEqual(
    untouched.map((row) => row.status),
    ['active', 'active'],
    'dryRun 动数据就等于"预览"变成了"执行"',
  )
})

test('P2-9：合并判决写 entity.merge journal 记录', async (t) => {
  const db = await openTestDb(t)
  if (!db) return
  const root = await tempRoot(t)
  const journal = new Journal({ root, deviceId: 'dev-a' })
  await journal.open()

  await seed(db, [
    { id: 'm1', kind: 'fact', subject: 'p.a', text: '重复的事实内容', trust: 0.9 },
    { id: 'm2', kind: 'fact', subject: 'p.b', text: '重复的事实内容', trust: 0.5 },
  ])

  const report = new Consolidator({ db, journal }).run({ workspaceId: WS, agentId: AGENT })
  assert.ok(report.deduped + report.merged >= 1, '同文必须触发一次合并')

  await journal.flush()
  const records = await journal.readMerged()
  const merge = records.find((record) => record.op === 'entity.merge')
  assert.ok(merge, '合并必须写 entity.merge 记录，否则换机后 loser 又活回来')
  assert.equal(merge.entityId, 'm2', 'loser 是 trust 低的那条')
  assert.equal(merge.mergedInto, 'm1', 'keeper 是 trust 高的那条')
  assert.equal(merge.workspaceId, WS)
  assert.equal(merge.agentId, AGENT)
})

test('T5：Consolidator journal.append 失败上报 onWarn，不产生 unhandledRejection', async (t) => {
  const db = await openTestDb(t)
  if (!db) return

  await seed(db, [
    { id: 't5a', kind: 'fact', subject: 'p.t5a', text: '完全相同的句子。', trust: 0.9 },
    { id: 't5b', kind: 'fact', subject: 'p.t5b', text: '完全相同的句子。', trust: 0.5 },
  ])

  // mock：append 总是 reject（模拟磁盘满 / IO 错误）。
  const failingJournal = {
    append: async () => {
      throw new Error('disk full')
    },
  } as unknown as Journal

  const warns: string[] = []
  const consolidator = new Consolidator({ db, journal: failingJournal, onWarn: (m) => warns.push(m) })

  // 监听 unhandledRejection：修复前 void journal.append() 丢弃 reject 会触发这里，
  // 修复后 .catch 处理掉就不会触发。
  let unhandled: unknown = null
  const handler = (reason: unknown) => {
    unhandled = reason
  }
  process.on('unhandledRejection', handler)
  try {
    const report = consolidator.run({ workspaceId: WS, agentId: AGENT })
    assert.equal(report.deduped + report.merged, 1, '同文必须触发一次合并')
    // 等一个宏任务让 unhandledRejection（若有）有机会触发。
    await new Promise((r) => setTimeout(r, 30))
    assert.equal(unhandled, null, 'journal.append 失败不应产生 unhandledRejection')
    assert.ok(warns.length > 0, 'journal.append 失败应上报 onWarn')
  } finally {
    process.off('unhandledRejection', handler)
  }
})
