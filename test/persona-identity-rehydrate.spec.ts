/**
 * 身份绑定回灌（persona-identity rehydrate）的时间守卫
 * ---------------------------------------------------------------------------
 * 这份测试钉的是第五次同构缺陷（v0.6.5 遗留）：
 *
 *   `persona_identity.replace()` 的 upsert 没有任何 WHERE —— 旧快照回灌时
 *   `persona_id`（"这个会话归哪个人格"的绑定点）被无条件覆盖，而
 *   `last_seen_at` 被 MAX 抬高，事后从时间戳看上去像是刚活跃过。
 *   用户看到的现象是"换了人格、模型却继续用旧人格的记忆回答"，全程无报错。
 *
 * 修法同前四次：内容列走守卫，基准用快照时刻（manifest.createdAt）。
 * 这里要保证：
 *   ① 快照比本机行旧 → 一行都不许改（不回退）；
 *   ② 快照比本机行新 → 必须覆盖（多设备漫游要靠它）；
 *   ③ 文件里自带 lastSeenAt 时以文件为准（比 capturedAt 更精确）；
 *   ④ 调用方没给 capturedAt 时退回本机时钟（老调用点行为不变）；
 *   ⑤ 文件不存在 → 一条都不动（老快照不能清空本机绑定）。
 */

import assert from 'node:assert/strict'
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import test, { type TestContext } from 'node:test'

import { rehydratePersonaIdentitiesFromRepo } from '../src/host/prompt/persona-identity-rehydrate.js'
import { openTestDb, tempRoot } from './helpers/db.js'

const AGENT = 'session-1'
const WORKSPACE = 'ws-1'
const DEVICE = 'dev-a'
const LOCAL_LAST_SEEN = 2000
const LOCAL_PERSONA = 'persona-local'
const SNAPSHOT_PERSONA = 'persona-from-snapshot'

interface Fixture {
  readonly db: NonNullable<Awaited<ReturnType<typeof openTestDb>>>
  readonly root: string
}

/** 本机行的 last_seen_at = LOCAL_LAST_SEEN，绑在 LOCAL_PERSONA 上。 */
async function seedLocalRow(t: TestContext): Promise<Fixture | undefined> {
  const db = await openTestDb(t)
  if (!db) return undefined
  const root = await tempRoot(t, 'persona-identity-rehydrate-')
  db.run(
    `INSERT INTO persona_identity (agent_id, workspace_id, persona_id, bound_at, last_seen_at)
     VALUES (?,?,?,?,?)`,
    [AGENT, WORKSPACE, LOCAL_PERSONA, 500, LOCAL_LAST_SEEN],
  )
  return { db, root }
}

/** 造一份某设备写出的快照目录：state/<device>/persona-identity.json。 */
async function seedSnapshot(
  root: string,
  identity: Record<string, unknown>,
): Promise<void> {
  await mkdir(join(root, 'state', DEVICE), { recursive: true })
  await writeFile(
    join(root, 'state', DEVICE, 'persona-identity.json'),
    JSON.stringify({ version: 1, device: DEVICE, identities: [{ agentId: AGENT, workspaceId: WORKSPACE, ...identity }] }),
    'utf8',
  )
}

function binding(db: Fixture['db']): { persona_id: string; last_seen_at: number } | undefined {
  return db.one<{ persona_id: string; last_seen_at: number }>(
    `SELECT persona_id, last_seen_at FROM persona_identity WHERE agent_id = ?`,
    [AGENT],
  )
}

test('① 旧快照不得把绑定打回旧人格', async (t) => {
  const f = await seedLocalRow(t)
  if (!f) return t.skip('node:sqlite 不可用')
  await seedSnapshot(f.root, { personaId: SNAPSHOT_PERSONA, boundAt: 400, lastSeenAt: 800 })

  const r = await rehydratePersonaIdentitiesFromRepo({
    db: f.db,
    root: f.root,
    capturedAt: 800,
  })

  assert.equal(r.present, true)
  assert.equal(binding(f.db)?.persona_id, LOCAL_PERSONA, '本机更新，旧快照必须一行不改')
  assert.equal(binding(f.db)?.last_seen_at, LOCAL_LAST_SEEN)
})

test('② 新快照必须生效（多设备漫游靠这条）', async (t) => {
  const f = await seedLocalRow(t)
  if (!f) return t.skip('node:sqlite 不可用')
  await seedSnapshot(f.root, { personaId: SNAPSHOT_PERSONA })

  await rehydratePersonaIdentitiesFromRepo({ db: f.db, root: f.root, capturedAt: LOCAL_LAST_SEEN + 1000 })

  assert.equal(binding(f.db)?.persona_id, SNAPSHOT_PERSONA)
  assert.equal(binding(f.db)?.last_seen_at, LOCAL_LAST_SEEN + 1000)
})

test('③ 文件自带的 lastSeenAt 优先于 capturedAt', async (t) => {
  const f = await seedLocalRow(t)
  if (!f) return t.skip('node:sqlite 不可用')
  await seedSnapshot(f.root, { personaId: SNAPSHOT_PERSONA, boundAt: 3000, lastSeenAt: 3000 })

  // capturedAt 比本机旧、文件自己比本机新：以文件为准 → 生效。
  await rehydratePersonaIdentitiesFromRepo({ db: f.db, root: f.root, capturedAt: 100 })

  assert.equal(binding(f.db)?.persona_id, SNAPSHOT_PERSONA)
  assert.equal(binding(f.db)?.last_seen_at, 3000)
})

test('④ 没给 capturedAt 时退回本机时钟（老调用点行为不变）', async (t) => {
  const f = await seedLocalRow(t)
  if (!f) return t.skip('node:sqlite 不可用')
  await seedSnapshot(f.root, { personaId: SNAPSHOT_PERSONA })

  await rehydratePersonaIdentitiesFromRepo({
    db: f.db,
    root: f.root,
    clock: () => LOCAL_LAST_SEEN + 5000,
  })

  assert.equal(binding(f.db)?.persona_id, SNAPSHOT_PERSONA, '与修复前一致：无 capturedAt 即用本机时钟')
})

test('⑤ 快照里没有这个文件时，一条都不动', async (t) => {
  const f = await seedLocalRow(t)
  if (!f) return t.skip('node:sqlite 不可用')

  const r = await rehydratePersonaIdentitiesFromRepo({ db: f.db, root: f.root, capturedAt: 9999 })

  assert.equal(r.present, false)
  assert.equal(binding(f.db)?.persona_id, LOCAL_PERSONA, '老快照不能清空本机绑定')
})
