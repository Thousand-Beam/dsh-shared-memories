/**
 * 会话身份 → 人格身份（修"换个新会话人格就丢了"）。
 * ---------------------------------------------------------------------------
 * 这份测试钉死的是真机事故的根因：宿主里 `agent.id === agent.session.id`，
 * 每点一次「新建会话」就是一个全新 agent id，而人格与记忆都按 agent_id 存。
 *
 * 于是要证明四条：
 *   ① 新会话**继承**本工作区最近活跃的人格（resolve 之后读到的就是同一个人）；
 *   ② 关掉继承时每个会话独立（旧行为，必须还能用）；
 *   ③ 绑定写 journal 且 payload 足够重建（不然换机器绑定丢了 = 又失忆）；
 *   ④ 老库回填：空壳会话行归到有记忆的锚点上，有名字/有记忆的行保持独立。
 */

import assert from 'node:assert/strict'
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import test, { type TestContext } from 'node:test'

import { Journal } from '../src/shared/journal.js'
import {
  backfillPersonaIdentities,
  PersonaIdentityStore,
  resolvePersonaId,
} from '../src/host/memory/persona-identity.js'
import { rehydratePersonaIdentitiesFromRepo } from '../src/host/prompt/persona-identity-rehydrate.js'
import { openTestDb, tempRoot } from './helpers/db.js'

const NOW = Date.UTC(2026, 0, 15, 3, 0, 0)
const WORKSPACE = 'ws-identity'
const OTHER_WORKSPACE = 'ws-identity-other'
const OLD_SESSION = 'session-11111111-1111-4111-8111-111111111111'
const NEW_SESSION = 'session-22222222-2222-4222-8222-222222222222'
const THIRD_SESSION = 'session-33333333-3333-4333-8333-333333333333'

type Db = NonNullable<Awaited<ReturnType<typeof openTestDb>>>

async function openDb(t: TestContext): Promise<Db | undefined> {
  return (await openTestDb(t)) ?? undefined
}

test('新会话继承最近活跃的人格：resolve 之后读到的是同一个人', async (t) => {
  const db = await openDb(t)
  if (!db) return

  const store = new PersonaIdentityStore({ db, clock: () => NOW })
  // 第一个会话：自己是人格。
  const first = await store.touch(OLD_SESSION, WORKSPACE)
  assert.equal(first, OLD_SESSION, '第一个会话成为人格锚点')

  // 第二个会话（用户在界面上点了「新建会话」）：应当继承第一个。
  const second = await store.touch(NEW_SESSION, WORKSPACE)
  assert.equal(second, OLD_SESSION, '新会话必须挂到已有的人格上')
  assert.equal(resolvePersonaId(db, NEW_SESSION), OLD_SESSION)

  // 同一会话重复出现：幂等，不新增绑定。
  assert.equal(await store.touch(NEW_SESSION, WORKSPACE), OLD_SESSION)
  assert.equal(store.all().length, 2, '两个会话 = 两行绑定，不重复')

  const personas = store.personas(WORKSPACE)
  assert.equal(personas.length, 1, '两个人格会话其实是一个人')
  assert.equal(personas[0]?.sessionCount, 2)
})

test('有名字的人格优先于最近活跃的空壳：新会话不会继承到「还没起名」', async (t) => {
  const db = await openDb(t)
  if (!db) return

  const store = new PersonaIdentityStore({ db, clock: () => NOW })
  await store.touch(OLD_SESSION, WORKSPACE)
  // 用户给 AI 起了名字：老会话的人格有了真名字。
  db.run(
    `INSERT INTO persona_state (agent_id, workspace_id, name, age, traits, baseline_hash, updated_at)
     VALUES (?,?,?,?,?,?,?)
     ON CONFLICT(agent_id, workspace_id) DO UPDATE SET name = excluded.name`,
    [OLD_SESSION, WORKSPACE, '普瑞赛斯', 10, '{}', '', NOW],
  )

  // 再塞一个「空壳但更新」的历史遗留：name 是它自己的 agent id，last_seen 比谁都新。
  // 只看活跃时间的老规则会选中它——用户起的名字永远轮不到继承。
  db.run(
    `INSERT INTO persona_state (agent_id, workspace_id, name, age, traits, baseline_hash, updated_at)
     VALUES (?,?,?,?,?,?,?)`,
    [THIRD_SESSION, WORKSPACE, THIRD_SESSION, 10, '{}', '', NOW],
  )
  db.run(
    `INSERT INTO persona_identity (agent_id, workspace_id, persona_id, bound_at, last_seen_at)
     VALUES (?,?,?,?,?)`,
    [THIRD_SESSION, WORKSPACE, THIRD_SESSION, NOW - 1_000, NOW + 60_000],
  )

  assert.equal(
    store.preview(NEW_SESSION, WORKSPACE),
    OLD_SESSION,
    '有空壳更活跃时，仍要认有名字的那一个',
  )
  assert.equal(await store.touch(NEW_SESSION, WORKSPACE), OLD_SESSION)
})

test('关掉继承：每个会话都是独立人格（旧行为可回退）', async (t) => {
  const db = await openDb(t)
  if (!db) return

  const store = new PersonaIdentityStore({ db, clock: () => NOW, inheritOnNewSession: false })
  await store.touch(OLD_SESSION, WORKSPACE)
  const second = await store.touch(NEW_SESSION, WORKSPACE)
  assert.equal(second, NEW_SESSION, '关掉继承后新会话是自己的锚点')
  assert.equal(store.personas(WORKSPACE).length, 2)
})

test('不跨工作区继承：A 项目的人格不会被 B 项目的新会话认领', async (t) => {
  const db = await openDb(t)
  if (!db) return

  const store = new PersonaIdentityStore({ db, clock: () => NOW })
  await store.touch(OLD_SESSION, WORKSPACE)
  const other = await store.touch(NEW_SESSION, OTHER_WORKSPACE)
  assert.equal(other, NEW_SESSION, '跨项目继承 = 把 A 客户的记忆给 B 客户看，绝不允许')
})

test('绑定写 journal 且 payload 足以重建（换机器不丢继承关系）', async (t) => {
  const db = await openDb(t)
  if (!db) return
  const root = await tempRoot(t)
  const journal = new Journal({ root, deviceId: 'dev-identity', clock: () => NOW })
  await journal.open()

  const store = new PersonaIdentityStore({ db, journal, clock: () => NOW })
  await store.touch(OLD_SESSION, WORKSPACE)
  await store.touch(NEW_SESSION, WORKSPACE)

  const records = await journal.readMerged()
  const binds = records.filter((record) => record.op === 'persona.bind')
  assert.equal(binds.length, 2)
  const last = binds[1]
  assert.ok(last)
  assert.equal(last.agentId, NEW_SESSION)
  assert.equal(last.personaId, OLD_SESSION)
  assert.equal(last.workspaceId, WORKSPACE)
})

test('手动改绑与拆分：bindTo / split 都能立刻生效', async (t) => {
  const db = await openDb(t)
  if (!db) return

  const store = new PersonaIdentityStore({ db, clock: () => NOW })
  await store.touch(OLD_SESSION, WORKSPACE)
  await store.touch(NEW_SESSION, WORKSPACE)
  assert.equal(store.resolve(THIRD_SESSION), THIRD_SESSION)

  // 把一个陌生会话挂到已有的人格下。
  await store.bindTo(THIRD_SESSION, WORKSPACE, OLD_SESSION)
  assert.equal(store.resolve(THIRD_SESSION), OLD_SESSION)

  // 再把它拆出去：独立人格。
  await store.bindTo(THIRD_SESSION, WORKSPACE, THIRD_SESSION)
  assert.equal(store.resolve(THIRD_SESSION), THIRD_SESSION)
})

test('老库回填：空壳会话归到锚点，有名字的行保持独立', async (t) => {
  const db = await openDb(t)
  if (!db) return

  const insert = (agentId: string, name: string, updatedAt: number): void => {
    db.run(
      `INSERT INTO persona_state (agent_id, workspace_id, name, age, traits, baseline_hash, updated_at)
       VALUES (?,?,?,?,?,?,?)`,
      [agentId, WORKSPACE, name, 10, '{}', '', updatedAt],
    )
  }
  // 真正在用的那个人：有名字、有一条记忆。
  insert('agent-real', '翟千瑶', NOW - 3000)
  db.run(
    `INSERT INTO memory_entity (entity_id, workspace_id, agent_id, kind, subject_key, canonical,
       salience, trust, status, content_hash, created_at, updated_at, device_id)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    ['e1', WORKSPACE, 'agent-real', 'fact', 'k', 'v', 0.5, 0.8, 'active', 'h', NOW, NOW, 'dev'],
  )
  // 两个空壳：没名字、没记忆（历史上每次 agent/created 都会留一行）。
  insert('session-44444444-4444-4444-8444-444444444444', '', NOW - 2000)
  insert('session-55555555-5555-4555-8555-555555555555', 'session-55555555-5555-4555-8555-555555555555', NOW - 1000)
  // 另一个"真的在并行"的 Agent：有名字、没记忆。
  insert('agent-other', '小狐狸', NOW - 500)

  const adopted = backfillPersonaIdentities(db, () => NOW)
  assert.equal(adopted, 2, '两个空壳被归并到锚点')

  const store = new PersonaIdentityStore({ db, clock: () => NOW })
  assert.equal(store.resolve('session-44444444-4444-4444-8444-444444444444'), 'agent-real')
  assert.equal(store.resolve('session-55555555-5555-4555-8555-555555555555'), 'agent-real')
  assert.equal(store.resolve('agent-other'), 'agent-other', '有名字的 Agent 不该被并掉')
  assert.equal(store.personas(WORKSPACE).length, 2)
})

test('回灌：没有 state/persona-identity.json 时一条都不动（老快照不清空本机）', async (t) => {
  const db = await openDb(t)
  if (!db) return
  const root = await tempRoot(t)
  const store = new PersonaIdentityStore({ db, clock: () => NOW })
  await store.touch(OLD_SESSION, WORKSPACE)

  const result = await rehydratePersonaIdentitiesFromRepo({ db, root })
  assert.equal(result.present, false)
  assert.equal(result.identities, 0)
  assert.equal(store.all().length, 1, '本机已有绑定必须原样保留')
})

test('回灌：文件存在时按文件对齐（设备 B 恢复后新会话照样继承）', async (t) => {
  const db = await openDb(t)
  if (!db) return
  const root = await tempRoot(t)
  await mkdir(join(root, 'state'), { recursive: true })
  await writeFile(
    join(root, 'state', 'persona-identity.json'),
    JSON.stringify({
      version: 1,
      identities: [
        { agentId: OLD_SESSION, workspaceId: WORKSPACE, personaId: OLD_SESSION, boundAt: NOW, lastSeenAt: NOW },
        { agentId: NEW_SESSION, workspaceId: WORKSPACE, personaId: OLD_SESSION, boundAt: NOW + 1, lastSeenAt: NOW + 1 },
      ],
    }),
    'utf8',
  )

  const result = await rehydratePersonaIdentitiesFromRepo({ db, root })
  assert.equal(result.present, true)
  assert.equal(result.identities, 2)

  const store = new PersonaIdentityStore({ db, clock: () => NOW })
  assert.equal(store.resolve(NEW_SESSION), OLD_SESSION)
  assert.equal(store.resolve(OLD_SESSION), OLD_SESSION)
})
