/**
 * 人格回灌（persona rehydrate）的时间守卫
 * ---------------------------------------------------------------------------
 * 这份测试钉的是一条真实漏洞（v0.6.4 遗留）：
 *
 *   人格文件由 collectAgents 物化，只写 name / age / traits / baselineHash /
 *   workspaceId —— **没有 updatedAt**。回灌的 upsert 又拿
 *   `num(persona?.updatedAt) ?? now` 当 excluded.updated_at，于是守卫
 *   `WHERE excluded.updated_at >= persona_state.updated_at` 恒真：
 *   每次 sync 都把 journal 刚重放出来的新人格按旧快照打回去，而且没有任何报错。
 *
 * 修法是把"这份文件代表哪一刻"交给调用方（manifest.createdAt），所以这里要保证：
 *   ① 快照比本机行旧 → 一行都不许改（不回退）；
 *   ② 快照比本机行新 → 必须覆盖（多设备漫游要靠它）；
 *   ③ 文件里若自带 updatedAt，以文件自己的时间为准（更精确）；
 *   ④ 调用方没给 capturedAt 时退回本机时钟（老调用点行为不变）。
 */

import assert from 'node:assert/strict'
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import test, { type TestContext } from 'node:test'

import { rehydratePersonaFromRepo } from '../src/host/prompt/persona-rehydrate.js'
import { openTestDb, tempRoot } from './helpers/db.js'

const AGENT = 'agent-1'
const WORKSPACE = 'ws-1'
const DEVICE = 'dev-a'
const LOCAL_UPDATED_AT = 2000

interface Fixture {
  readonly db: NonNullable<Awaited<ReturnType<typeof openTestDb>>>
  readonly root: string
}

/** 造一份"某台设备写出的快照目录"：state/<device>/agents.json + persona/<agent>.json。 */
async function seed(
  t: TestContext,
  persona: Record<string, unknown>,
): Promise<Fixture | undefined> {
  const db = await openTestDb(t)
  if (!db) return undefined
  const root = await tempRoot(t, 'persona-rehydrate-')
  await mkdir(join(root, 'state', DEVICE), { recursive: true })
  await mkdir(join(root, 'persona'), { recursive: true })
  await writeFile(
    join(root, 'state', DEVICE, 'agents.json'),
    JSON.stringify({
      version: 1,
      device: DEVICE,
      agents: [{ agentId: AGENT, workspaceIds: [WORKSPACE], hasPersona: true }],
    }),
    'utf8',
  )
  await writeFile(join(root, 'persona', `${AGENT}.json`), `${JSON.stringify(persona, null, 2)}\n`, 'utf8')
  // 本机行：用户在快照之后改过名字（updated_at 比快照新）。
  db.run(
    `INSERT INTO persona_state (agent_id, workspace_id, name, age, traits, baseline_hash, updated_at)
     VALUES (?,?,?,?,?,?,?)`,
    [AGENT, WORKSPACE, '本机改过的名字', 41, '{"tone":"dry"}', 'h-local', LOCAL_UPDATED_AT],
  )
  return { db, root }
}

function row(db: Fixture['db']): { name: string; age: number; updated_at: number } {
  const found = db.one<{ name: string; age: number; updated_at: number }>(
    `SELECT name, age, updated_at FROM persona_state WHERE agent_id = ? AND workspace_id = ?`,
    [AGENT, WORKSPACE],
  )
  assert.ok(found, '本机行必须还在')
  return found
}

const SNAPSHOT_PERSONA = { name: '快照里的旧名字', age: 10, traits: {}, baselineHash: 'h-snap' }

test('T1：旧快照回灌不得覆盖 journal 重放出的新人格', async (t) => {
  const fx = await seed(t, SNAPSHOT_PERSONA)
  if (!fx) return

  const result = await rehydratePersonaFromRepo({
    db: fx.db,
    root: fx.root,
    capturedAt: LOCAL_UPDATED_AT - 1000, // 快照比本机行旧
  })

  assert.equal(result.personas, 1, '文件读到了、SQL 也执行了')
  assert.deepEqual(
    { name: row(fx.db).name, age: row(fx.db).age },
    { name: '本机改过的名字', age: 41 },
    '旧快照不许把名字和年龄打回去',
  )
  assert.equal(row(fx.db).updated_at, LOCAL_UPDATED_AT, '本机时间戳不许被抬高')
})

test('T1 反向：快照比本机新时必须回灌（否则多设备漫游拿不到别人的人格）', async (t) => {
  const fx = await seed(t, SNAPSHOT_PERSONA)
  if (!fx) return

  const result = await rehydratePersonaFromRepo({
    db: fx.db,
    root: fx.root,
    capturedAt: LOCAL_UPDATED_AT + 1000,
  })

  assert.equal(result.personas, 1)
  assert.equal(row(fx.db).name, '快照里的旧名字', '这一侧必须真的覆盖')
  assert.equal(row(fx.db).age, 10)
  assert.equal(row(fx.db).updated_at, LOCAL_UPDATED_AT + 1000, '时间戳取快照时刻')
})

test('人格文件自带 updatedAt 时以文件为准（比快照时刻更精确）', async (t) => {
  const fx = await seed(t, { ...SNAPSHOT_PERSONA, updatedAt: LOCAL_UPDATED_AT - 1 })
  if (!fx) return

  await rehydratePersonaFromRepo({
    db: fx.db,
    root: fx.root,
    capturedAt: LOCAL_UPDATED_AT + 1000, // 快照整体很新，但这个人格条目本身旧
  })

  assert.equal(row(fx.db).name, '本机改过的名字', '文件自己的时间早于本机行 → 不覆盖')
})

test('缺省 capturedAt 时退回本机时钟（老调用点行为不变）', async (t) => {
  const fx = await seed(t, SNAPSHOT_PERSONA)
  if (!fx) return

  await rehydratePersonaFromRepo({
    db: fx.db,
    root: fx.root,
    clock: () => LOCAL_UPDATED_AT + 5000,
  })

  assert.equal(row(fx.db).name, '快照里的旧名字', '没有 capturedAt 时按 now 判断，会覆盖')
})
