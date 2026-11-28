/**
 * 技能回灌（skill rehydrate）的时间守卫
 * ---------------------------------------------------------------------------
 * 第六次同构缺陷：`SkillRegistry.replaceAll()` 是"对齐"语义（清单即真相，
 * 清单外的技能会被删掉），但它每次都用 `this.#clock()` 给所有行盖上"现在"的
 * 时间戳，且不比较新旧 —— 旧快照回灌会把用户刚关掉的技能重新打开、
 * 把刚从别的设备加的技能删掉，全程无报错。
 *
 * 修法：守卫按 (workspace, agent) 粒度判一次 —— 本机有任何一行比 capturedAt 新，
 * 整条不动；写入行的 updated_at 用 capturedAt，而不是 now。
 *
 * ① 旧快照不得覆盖本机更新的技能状态；
 * ② 新快照必须生效，且"对齐"语义保留（清单外的删掉）；
 * ③ 本机为空时直接写入；
 * ④ 没给 capturedAt 时退回本机时钟（老调用点行为不变）；
 * ⑤ 文件不存在 → 一条都不动。
 */

import assert from 'node:assert/strict'
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import test, { type TestContext } from 'node:test'

import { rehydrateSkillsFromRepo } from '../src/host/prompt/skill-rehydrate.js'
import { openTestDb, tempRoot } from './helpers/db.js'

const AGENT = 'agent-1'
const WORKSPACE = 'ws-1'
const DEVICE = 'dev-a'
const LOCAL_AT = 2000

interface Fixture {
  readonly db: NonNullable<Awaited<ReturnType<typeof openTestDb>>>
  readonly root: string
}

async function seedLocal(t: TestContext): Promise<Fixture | undefined> {
  const db = await openTestDb(t)
  if (!db) return undefined
  const root = await tempRoot(t, 'skill-rehydrate-')
  db.run(
    `INSERT INTO agent_skill (agent_id, workspace_id, skill_id, version, enabled, config, granted_by, updated_at)
     VALUES (?,?,?,?,?,?,?,?)`,
    [AGENT, WORKSPACE, 'code-exec', '1.0.0', 1, '{}', 'user', LOCAL_AT],
  )
  return { db, root }
}

async function seedSnapshot(root: string, skills: { skillId: string; enabled?: boolean }[]): Promise<void> {
  await mkdir(join(root, 'state', DEVICE), { recursive: true })
  await writeFile(
    join(root, 'state', DEVICE, 'skills.json'),
    JSON.stringify({
      version: 1,
      device: DEVICE,
      agents: [{ agentId: AGENT, workspaceIds: [WORKSPACE], skills }],
    }),
    'utf8',
  )
}

function rows(db: Fixture['db']): { skill_id: string; enabled: number; updated_at: number }[] {
  return db.all<{ skill_id: string; enabled: number; updated_at: number }>(
    `SELECT skill_id, enabled, updated_at FROM agent_skill WHERE agent_id = ? AND workspace_id = ? ORDER BY skill_id`,
    [AGENT, WORKSPACE],
  )
}

test('① 旧快照不得覆盖本机更新的技能状态', async (t) => {
  const f = await seedLocal(t)
  if (!f) return t.skip('node:sqlite 不可用')
  await seedSnapshot(f.root, [{ skillId: 'web-search' }])

  const r = await rehydrateSkillsFromRepo({ db: f.db, root: f.root, capturedAt: 800 })

  assert.equal(r.present, true)
  assert.deepEqual(rows(f.db).map((x) => x.skill_id), ['code-exec'], '本机更新，旧快照一条都不许动')
  assert.equal(rows(f.db)[0]?.updated_at, LOCAL_AT)
})

test('② 新快照必须生效，且清单外的技能被删掉', async (t) => {
  const f = await seedLocal(t)
  if (!f) return t.skip('node:sqlite 不可用')
  await seedSnapshot(f.root, [{ skillId: 'web-search' }])

  await rehydrateSkillsFromRepo({ db: f.db, root: f.root, capturedAt: 3000 })

  const after = rows(f.db)
  assert.deepEqual(after.map((x) => x.skill_id), ['web-search'], '对齐语义：清单外的删掉')
  assert.equal(after[0]?.updated_at, 3000, '写入行的 updated_at 用快照时刻，不是 now')
})

test('③ 本机为空时直接写入', async (t) => {
  const db = await openTestDb(t)
  if (!db) return t.skip('node:sqlite 不可用')
  const root = await tempRoot(t, 'skill-rehydrate-')
  await seedSnapshot(root, [{ skillId: 'code-exec' }, { skillId: 'web-search' }])

  const r = await rehydrateSkillsFromRepo({ db, root, capturedAt: 1000 })

  assert.equal(r.bindings, 2)
  assert.deepEqual(rows(db).map((x) => x.skill_id), ['code-exec', 'web-search'])
})

test('④ 没给 capturedAt 时退回本机时钟（老调用点行为不变）', async (t) => {
  const f = await seedLocal(t)
  if (!f) return t.skip('node:sqlite 不可用')
  await seedSnapshot(f.root, [{ skillId: 'web-search' }])

  await rehydrateSkillsFromRepo({ db: f.db, root: f.root, clock: () => LOCAL_AT + 5000 })

  assert.deepEqual(rows(f.db).map((x) => x.skill_id), ['web-search'], '与修复前一致：无 capturedAt 即用本机时钟')
})

test('⑤ 快照里没有 skills.json 时，一条都不动', async (t) => {
  const f = await seedLocal(t)
  if (!f) return t.skip('node:sqlite 不可用')

  const r = await rehydrateSkillsFromRepo({ db: f.db, root: f.root, capturedAt: 9999 })

  assert.equal(r.present, false)
  assert.deepEqual(rows(f.db).map((x) => x.skill_id), ['code-exec'])
})
