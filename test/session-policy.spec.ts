/**
 * 无痕会话的"零痕迹"补刀（session-policy:forgetSessionTraces）：单测。
 *
 * 真机上的顺序是宿主的：`sessions.create()` 先发 `agent/created`，
 * 之后才把 sessionId 交回客户端 —— 而"无痕"这个选择是客户端拿到 id 才写进策略的。
 * 中间那一瞬，普通会话路径已经给它登记了 persona_identity / persona_state。
 *
 * 这里钉死两条边界：
 *   ① 空壳会话（名下没有记忆）→ 登记行全删干净，返回删了多少；
 *   ② 名下已有真实记忆 → **一行都不许碰**，宁可留个绑定，也不能毁掉归属。
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'

import { openTestDb, tempRoot } from './helpers/db.js'
import { Journal } from '../src/shared/journal.js'
import { TemporalTree } from '../src/host/memory/timetree.js'
import { PersonaIdentityStore } from '../src/host/memory/persona-identity.js'
import { forgetSessionTraces, ephemeralLeaks } from '../src/host/memory/session-policy.js'

const WORKSPACE = 'ws-session-policy'
const DEVICE = 'dev-a'

async function fixture(t: Parameters<typeof openTestDb>[0]): Promise<
  | {
      db: NonNullable<Awaited<ReturnType<typeof openTestDb>>>
      tree: TemporalTree
      identity: PersonaIdentityStore
    }
  | undefined
> {
  const db = await openTestDb(t)
  if (db === undefined) return undefined
  const root = await tempRoot(t)
  const journal = new Journal({ root, deviceId: DEVICE })
  await journal.open()
  return { db, tree: new TemporalTree(db, journal), identity: new PersonaIdentityStore({ db, journal }) }
}

test('无痕补刀：空壳会话的人格登记与画像全部抹掉', async (t) => {
  const f = await fixture(t)
  if (f === undefined) return

  // 等价于 agent/created 在策略落库之前干的活：登记人格 + 建画像 + 挂技能
  const personaId = await f.identity.touch('session-ghost', WORKSPACE)
  assert.equal(personaId, 'session-ghost', '新工作区里第一条会话自成一格')
  f.db.run(
    'INSERT INTO persona_state (agent_id, workspace_id, name, age, traits, baseline_hash, updated_at) VALUES (?,?,?,?,?,?,?)',
    ['session-ghost', WORKSPACE, '临时人格', 20, '{}', '', Date.now()],
  )
  f.db.run(
    'INSERT INTO agent_skill (agent_id, workspace_id, skill_id, version, enabled, config, granted_by, updated_at) VALUES (?,?,?,?,?,?,?,?)',
    ['session-ghost', WORKSPACE, 'web-search', '1.0.0', 1, '{}', 'user', Date.now()],
  )

  const removed = forgetSessionTraces(f.db, WORKSPACE, 'session-ghost')
  assert.equal(removed, 3, '人格 / 画像 / 技能三条登记都该消失')
  assert.equal(f.identity.lookup('session-ghost'), undefined)
  assert.equal(
    f.db.one<{ n: number }>('SELECT COUNT(*) AS n FROM persona_state WHERE agent_id = ?', ['session-ghost'])?.n,
    0,
  )
  assert.equal(
    f.db.one<{ n: number }>('SELECT COUNT(*) AS n FROM agent_skill WHERE agent_id = ?', ['session-ghost'])?.n,
    0,
  )
})

test('无痕补刀：名下已有记忆时一行都不碰（归属比干净更重要）', async (t) => {
  const f = await fixture(t)
  if (f === undefined) return

  const agentId = 'session-with-memory'
  await f.tree.openVersion({
    scope: { workspaceId: WORKSPACE, agentId, deviceId: DEVICE },
    kind: 'fact',
    subjectKey: 'runtime',
    text: '样式走运行时注入',
    author: 'user',
    trust: 0.9,
  })
  f.db.run(
    'INSERT INTO persona_state (agent_id, workspace_id, name, age, traits, baseline_hash, updated_at) VALUES (?,?,?,?,?,?,?)',
    [agentId, WORKSPACE, '真人格', 20, '{}', '', Date.now()],
  )

  const removed = forgetSessionTraces(f.db, WORKSPACE, agentId)
  assert.equal(removed, 0, '有记忆就不补刀')
  assert.equal(
    f.db.one<{ n: number }>('SELECT COUNT(*) AS n FROM persona_state WHERE agent_id = ?', [agentId])?.n,
    1,
    '画像必须还在',
  )
  assert.equal(
    f.db.one<{ n: number }>('SELECT COUNT(*) AS n FROM memory_entity WHERE agent_id = ?', [agentId])?.n,
    1,
    '记忆本身一条都不能少',
  )
})

test('无痕补刀：空 sessionId 直接返回 0（别让脏参数删库）', async (t) => {
  const f = await fixture(t)
  if (f === undefined) return
  assert.equal(forgetSessionTraces(f.db, WORKSPACE, ''), 0)
})

test('D-08：ephemeralLeaks 不把 persona_identity 绑定当泄漏，但真实记忆仍算泄漏', async (t) => {
  const f = await fixture(t)
  if (f === undefined) return

  const agentId = 'session-ephemeral-bound'
  // 会话创建时必然产生的 persona.bind：写 persona_identity 绑定（会话→人格）。
  await f.identity.touch(agentId, WORKSPACE)

  // 只有绑定、没有 memory_entity/pitfall/quarantine → 不算泄漏（否则"先正常用后切无痕"
  // 的会话会让快照永久停摆）。
  assert.deepEqual(
    ephemeralLeaks(f.db, WORKSPACE, [agentId]),
    [],
    'persona_identity 绑定是读锚点人格的路标，不是"聊了什么"的记忆痕迹',
  )

  // 真写一条记忆 → 仍然算泄漏（无痕会话名下不该有 memory_entity）。
  await f.tree.openVersion({
    scope: { workspaceId: WORKSPACE, agentId, deviceId: DEVICE },
    kind: 'fact',
    subjectKey: 'leak',
    text: '无痕会话不该留下的记忆',
    author: 'user',
    trust: 0.8,
  })
  assert.deepEqual(
    ephemeralLeaks(f.db, WORKSPACE, [agentId]),
    [agentId],
    'memory_entity 是真实记忆痕迹，必须判泄漏',
  )
})
