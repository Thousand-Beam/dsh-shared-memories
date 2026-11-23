/**
 * 时间树单测：A→B 版本关闭、历史补录切分、正文幂等去重、asOf 时间旅行。
 * ---------------------------------------------------------------------------
 * 这四个用例覆盖的是"记忆一旦写错就无法纠正"这件事的全部防线：
 * 版本必须能关、历史必须能补、重复写不能炸、任意时刻必须能读回当时的真相。
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import { Journal } from '../src/shared/journal.js'
import { TemporalTree } from '../src/host/memory/timetree.js'
import type { Scope } from '../src/shared/scope.js'
import { openTestDb, tempRoot } from './helpers/db.js'

const T1 = 1_700_000_000_000
const T2 = T1 + 1_000
const T3 = T1 + 2_000

const scopeA: Scope = { workspaceId: 'ws_python', agentId: 'agent_fish', deviceId: 'testdev' }
const scopeB: Scope = { workspaceId: 'ws_java', agentId: 'agent_fish', deviceId: 'testdev' }

/** 建一套"库 + 日志 + 时间树"，clock 固定，保证用例可复现。 */
async function harness(t: import('node:test').TestContext) {
  const db = await openTestDb(t)
  if (!db) return undefined
  const root = await tempRoot(t)
  const journal = new Journal({ root, deviceId: 'testdev', clock: () => T1 })
  await journal.open()
  const tree = new TemporalTree(db, journal, { clock: () => T1, emotionConfidenceGate: 0.6 })
  return { db, root, journal, tree }
}

test('A→B：写入新版本会关闭旧版本，且只留一个活跃版本', async (t) => {
  const h = await harness(t)
  if (!h) return

  const first = await h.tree.openVersion({
    scope: scopeA,
    kind: 'decision',
    subjectKey: 'project:dsh-shared-memories/git-auth',
    text: 'git 认证走 ssh-agent',
    validFrom: T1,
    author: 'user',
  })
  assert.equal(first.deduped, false)
  assert.equal(first.version.valid_until, null)

  const second = await h.tree.openVersion({
    scope: scopeA,
    kind: 'decision',
    subjectKey: 'project:dsh-shared-memories/git-auth',
    text: 'git 认证改走 credential-helper（Windows 上更稳）',
    validFrom: T2,
    author: 'user',
  })

  assert.equal(second.entity.entity_id, first.entity.entity_id, '同一实体键必须复用同一个 entity')
  assert.equal(second.deduped, false)
  assert.equal(second.affected.length, 1, '旧版本必须被记录为 affected')
  assert.equal(second.affected[0]?.version_id, first.version.version_id)
  assert.equal(second.affected[0]?.valid_until, T2)
  assert.equal(second.version.valid_from, T2)
  assert.equal(second.version.valid_until, null)

  // 库里只能有一个 valid_until IS NULL 的版本（由 uq_version_active 兜底）。
  const active = h.db.all<{ version_id: string }>(
    `SELECT version_id FROM memory_version WHERE entity_id = ? AND valid_until IS NULL`,
    [first.entity.entity_id],
  )
  assert.equal(active.length, 1)
  assert.equal(active[0]?.version_id, second.version.version_id)
})

test('V62-24：text 超过 8000 字符上限抛错', async (t) => {
  const h = await harness(t)
  if (!h) return
  const long = 'x'.repeat(8001)
  await assert.rejects(
    () =>
      h.tree.openVersion({
        scope: scopeA,
        kind: 'fact',
        subjectKey: 'huge.text',
        text: long,
        validFrom: T1,
        author: 'user',
      }),
    /8000 字符上限/,
  )
})

test('历史补录：validFrom 落在旧区间内时必须切分，且不碰之后的版本', async (t) => {
  const h = await harness(t)
  if (!h) return

  const subjectKey = 'project:dsh-shared-memories/sync-interval'
  const v1 = await h.tree.openVersion({
    scope: scopeA,
    kind: 'fact',
    subjectKey,
    text: '同步间隔 300 秒',
    validFrom: T1,
    author: 'user',
  })
  // 先写到"未来"（T3），制造一个 [T1, ∞) → [T1, T3) 的历史空洞
  const v3 = await h.tree.openVersion({
    scope: scopeA,
    kind: 'fact',
    subjectKey,
    text: '同步间隔 600 秒',
    validFrom: T3,
    author: 'user',
  })
  assert.equal(v1.version.version_id, v3.affected[0]?.version_id)

  // 事后补记 T2 的真相：必须切在 v1 上，且继承 v1 的区间终点 T3。
  const inserted = await h.tree.openVersion({
    scope: scopeA,
    kind: 'fact',
    subjectKey,
    text: '同步间隔 120 秒（临时调试）',
    validFrom: T2,
    author: 'user',
  })

  assert.equal(inserted.deduped, false)
  assert.equal(inserted.version.valid_from, T2)
  assert.equal(inserted.version.valid_until, T3, '补录版本必须继承被切分版本的区间终点')

  const rows = h.db.all<{ text: string; valid_from: number; valid_until: number | null }>(
    `SELECT text, valid_from, valid_until FROM memory_version
      WHERE entity_id = ? ORDER BY valid_from ASC`,
    [inserted.entity.entity_id],
  )
  assert.deepEqual(
    rows.map((row) => [row.text, row.valid_from, row.valid_until]),
    [
      ['同步间隔 300 秒', T1, T2],
      ['同步间隔 120 秒（临时调试）', T2, T3],
      ['同步间隔 600 秒', T3, null],
    ],
  )
})

test('幂等：同一区间内重复写入相同正文，不产生新版本', async (t) => {
  const h = await harness(t)
  if (!h) return

  const subjectKey = 'project:dsh-shared-memories/prd'
  const first = await h.tree.openVersion({
    scope: scopeA,
    kind: 'fact',
    subjectKey,
    text: '十二大核心需求',
    validFrom: T1,
    author: 'agent',
  })
  const again = await h.tree.openVersion({
    scope: scopeA,
    kind: 'fact',
    subjectKey,
    text: '十二大核心需求',
    validFrom: T2,
    author: 'agent',
  })

  assert.equal(again.deduped, true)
  assert.equal(again.version.version_id, first.version.version_id)
  assert.equal(again.affected.length, 0)

  const count = h.db.one<{ n: number }>(
    `SELECT COUNT(*) AS n FROM memory_version WHERE entity_id = ?`,
    [first.entity.entity_id],
  )
  assert.equal(count?.n, 1)
})

test('asOf：任意时刻都能读回"当时"的版本；跨工作区返回 undefined', async (t) => {
  const h = await harness(t)
  if (!h) return

  const subjectKey = 'project:dsh-shared-memories/retrieval'
  const a = await h.tree.openVersion({
    scope: scopeA,
    kind: 'decision',
    subjectKey,
    text: '检索只用关键词',
    validFrom: T1,
  })
  await h.tree.openVersion({
    scope: scopeA,
    kind: 'decision',
    subjectKey,
    text: '检索改成关键词+向量混合',
    validFrom: T2,
  })
  await h.tree.openVersion({
    scope: scopeA,
    kind: 'decision',
    subjectKey,
    text: '检索加 rerank 精排',
    validFrom: T3,
  })

  const entityId = a.entity.entity_id
  assert.equal(h.tree.asOf(entityId, T1 + 500, scopeA)?.text, '检索只用关键词')
  assert.equal(h.tree.asOf(entityId, T2 + 500, scopeA)?.text, '检索改成关键词+向量混合')
  assert.equal(h.tree.asOf(entityId, T3 + 500, scopeA)?.text, '检索加 rerank 精排')
  // 区间是左闭右开：T2 这一刻已经属于新版本
  assert.equal(h.tree.asOf(entityId, T2, scopeA)?.text, '检索改成关键词+向量混合')

  // 别的 workspace 读同一个 entity：不抛异常，但什么都读不到（读路径不泄露存在性）。
  assert.equal(h.tree.asOf(entityId, T2 + 500, scopeB), undefined)
})

test('journal：每次写入都会按"先关旧、再开新"的顺序落日志', async (t) => {
  const h = await harness(t)
  if (!h) return

  const subjectKey = 'project:dsh-shared-memories/journal'
  const first = await h.tree.openVersion({
    scope: scopeA,
    kind: 'fact',
    subjectKey,
    text: '第一版',
    validFrom: T1,
  })
  await h.tree.openVersion({
    scope: scopeA,
    kind: 'fact',
    subjectKey,
    text: '第二版',
    validFrom: T2,
  })
  await h.journal.flush()

  const ops: string[] = []
  for await (const record of h.journal.readDevice('testdev')) ops.push(record.op)

  assert.deepEqual(ops, [
    'entity.upsert',
    'version.open',
    'entity.upsert',
    'version.close',
    'version.open',
  ])
  assert.equal(typeof first.version.version_id, 'string')
  assert.ok(first.version.version_id.length > 0)
})

// 越权回归（评审 P1「fixEmotion 越权」）：拿别的会话的 versionId 改情感标注必须无效。
// 修前 fixEmotion 只按 version_id 查行，不校验实体归属，任何会话都能改别人的标注。
test('fixEmotion：拿别的 Agent 的 versionId 改情感标注被拒绝，且不改库', async (t) => {
  const h = await harness(t)
  if (!h) return

  const mine = await h.tree.openVersion({
    scope: scopeA,
    kind: 'fact',
    subjectKey: 'project:dsh-shared-memories/emotion-owner',
    text: '本会话的版本',
    validFrom: T1,
  })

  // 另一个 Agent 试图改本会话版本的情感标注。
  const intruder: Scope = { workspaceId: scopeA.workspaceId, agentId: 'agent_intruder', deviceId: 'testdev' }
  const outcome = await h.tree.fixEmotion({
    versionId: mine.version.version_id,
    label: 'anxiety',
    subject: '别人',
    trigger: '越权',
    intensity: 0.9,
    scope: intruder,
  })
  assert.equal(outcome.changed, false)

  // 库里的情感字段必须原封不动。
  const row = h.db.one<{ emo_label: string | null; emo_subject: string | null; emo_trigger: string | null }>(
    `SELECT emo_label, emo_subject, emo_trigger FROM memory_version WHERE version_id = ?`,
    [mine.version.version_id],
  )
  assert.equal(row?.emo_label ?? null, null)
  assert.equal(row?.emo_subject ?? null, null)
  assert.equal(row?.emo_trigger ?? null, null)

  // 本人改则生效（权限正路径）。
  const own = await h.tree.fixEmotion({
    versionId: mine.version.version_id,
    label: 'anxiety',
    subject: '依赖装不上',
    trigger: '卡了两小时',
    intensity: 0.8,
    scope: scopeA,
  })
  assert.equal(own.changed, true)
  const after = h.db.one<{ emo_label: string | null; emo_subject: string | null }>(
    `SELECT emo_label, emo_subject FROM memory_version WHERE version_id = ?`,
    [mine.version.version_id],
  )
  assert.equal(after?.emo_label, 'anxiety')
  assert.equal(after?.emo_subject, '依赖装不上')
})
