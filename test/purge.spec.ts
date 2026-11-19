/**
 * 彻底销毁：库与 journal 必须一起清。
 *
 * 这一组测试盯的是"删了但还在"这个最恶心的情况：
 * 只删库 → 下次冷启动 replay 把它重建回来；只删 journal → 库里仍是活的。
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFile, writeFile, mkdir, access } from 'node:fs/promises'
import { join } from 'node:path'

import { openTestDb, tempRoot } from './helpers/db.js'
import { Journal } from '../src/shared/journal.js'
import { TemporalTree } from '../src/host/memory/timetree.js'
import { PersonaIdentityStore } from '../src/host/memory/persona-identity.js'
import { purgeAgent } from '../src/host/memory/purge.js'
import { ScopedQuery } from '../src/host/memory/scoped-query.js'

const WORKSPACE = 'ws-purge'

test('purgeAgent 清空该人格的记忆、人格行与绑定', async (t) => {
  const db = await openTestDb(t)
  if (db === undefined) return
  const root = await tempRoot(t, 'purge-')
  const journal = new Journal({ root, deviceId: 'dev-a' })
  await journal.open()
  const tree = new TemporalTree(db, journal)
  const identity = new PersonaIdentityStore({ db, journal })

  await identity.touch('session-a', WORKSPACE)
  await identity.touch('session-b', WORKSPACE)
  const personaId = identity.resolve('session-a')

  const scope = { workspaceId: WORKSPACE, agentId: personaId, deviceId: 'dev-a' }
  await tree.openVersion({ scope, kind: 'fact', subjectKey: 'a', text: '第一条', author: 'user', trust: 1 })
  await tree.openVersion({ scope, kind: 'fact', subjectKey: 'b', text: '第二条', author: 'user', trust: 1 })

  const before = new ScopedQuery(db, scope).stats()
  assert.equal(before.entities, 2)

  const result = await purgeAgent({ db, root, workspaceId: WORKSPACE, agentId: personaId })
  assert.equal(result.entities, 2)
  assert.ok(result.identities >= 1)

  assert.equal(new ScopedQuery(db, scope).stats().entities, 0)
  assert.equal(identity.resolve('session-a'), 'session-a', '绑定被清掉后退回自身')
  assert.equal(identity.resolve('session-b'), 'session-b')
})

test('purgeAgent 物理抹除 journal 记录，并写 agent.purge 墓碑', async (t) => {
  const db = await openTestDb(t)
  if (db === undefined) return
  const root = await tempRoot(t, 'purge-journal-')
  const journal = new Journal({ root, deviceId: 'dev-a' })
  await journal.open()
  const tree = new TemporalTree(db, journal)
  const scope = { workspaceId: WORKSPACE, agentId: 'session-x', deviceId: 'dev-a' }
  await tree.openVersion({ scope, kind: 'fact', subjectKey: 'secret', text: '这段文字不该留下', author: 'user', trust: 1 })

  const file = join(root, 'journal', 'devices', 'dev-a', `${new Date().toISOString().slice(0, 10)}.jsonl`)
  const before = await readFile(file, 'utf8')
  assert.ok(before.includes('这段文字不该留下'))

  const result = await purgeAgent({ db, root, workspaceId: WORKSPACE, agentId: 'session-x' })
  assert.ok(result.records >= 1)

  const after = await readFile(file, 'utf8')
  assert.equal(after.includes('这段文字不该留下'), false, 'journal 里不能再有原文')

  const tombstone = join(root, 'journal', 'devices', 'purge', `${new Date().toISOString().slice(0, 10)}.jsonl`)
  const text = await readFile(tombstone, 'utf8')
  assert.ok(text.includes('agent.purge'))
  assert.ok(text.includes('session-x'))

  // P0-2：墓碑必须带 Lamport lc 且压过全 journal 最大 lc，否则跨设备 replay 时
  // 其他设备带更大 lc 的 upsert 会排在墓碑（lc=0）后面，把已销毁 Agent 复活。
  const tombstoneLine = text.trim().split('\n').pop()!
  const tombstoneRecord = JSON.parse(tombstoneLine) as { lc?: number; op: string }
  assert.equal(tombstoneRecord.op, 'agent.purge')
  assert.equal(typeof tombstoneRecord.lc, 'number', '墓碑必须带 lc 字段')
  // 本例 dev-a 已有一条 version.open（lc=1），墓碑 lc 必须 > 1。
  assert.ok(tombstoneRecord.lc! >= 2, `墓碑 lc 应压过现有记录（>=2），实际 ${tombstoneRecord.lc}`)
})

test('purgeAgent 不碰别人的记录', async (t) => {
  const db = await openTestDb(t)
  if (db === undefined) return
  const root = await tempRoot(t, 'purge-other-')
  const journal = new Journal({ root, deviceId: 'dev-a' })
  await journal.open()
  const tree = new TemporalTree(db, journal)
  await tree.openVersion({ scope: { workspaceId: WORKSPACE, agentId: 'keep-me', deviceId: 'dev-a' }, kind: 'fact', subjectKey: 'k', text: '保留我', author: 'user', trust: 1 })
  await tree.openVersion({ scope: { workspaceId: WORKSPACE, agentId: 'drop-me', deviceId: 'dev-a' }, kind: 'fact', subjectKey: 'd', text: '删掉我', author: 'user', trust: 1 })

  await purgeAgent({ db, root, workspaceId: WORKSPACE, agentId: 'drop-me' })

  const kept = new ScopedQuery(db, { workspaceId: WORKSPACE, agentId: 'keep-me', deviceId: 'dev-a' })
  assert.equal(kept.stats().entities, 1)
  const dropped = new ScopedQuery(db, { workspaceId: WORKSPACE, agentId: 'drop-me', deviceId: 'dev-a' })
  assert.equal(dropped.stats().entities, 0)
})

test('journal 目录不存在时 purge 也不报错（全新机器）', async (t) => {
  const db = await openTestDb(t)
  if (db === undefined) return
  const root = await tempRoot(t, 'purge-empty-')
  await mkdir(join(root, 'journal'), { recursive: true })
  await writeFile(join(root, 'journal', 'keep.txt'), 'x', 'utf8')
  const result = await purgeAgent({ db, root, workspaceId: WORKSPACE, agentId: 'nobody' })
  assert.equal(result.entities, 0)
  assert.equal(result.records, 0)
})

test('dropHostSessionTraces 只删会话日志，不碰投影缓存与 workspace 记账', async (t) => {
  const db = await openTestDb(t)
  if (db === undefined) return
  const root = await tempRoot(t, 'purge-host-')
  const hostRoot = join(root, 'host')
  const agentId = 'victim'
  const slug = '--C-Users-Test-default-workspace--'

  // 两种命名的会话日志（裸 uuid 与 session- 前缀）
  await mkdir(join(hostRoot, 'sessions', slug, agentId), { recursive: true })
  await writeFile(join(hostRoot, 'sessions', slug, agentId, 'session.v4.jsonl.zstd'), 'victim-log', 'utf8')
  await mkdir(join(hostRoot, 'sessions', slug, `session-${agentId}`), { recursive: true })
  await writeFile(join(hostRoot, 'sessions', slug, `session-${agentId}`, 'session.v4.jsonl.zstd'), 'victim-log-prefixed', 'utf8')

  // 别人的会话日志，不该动
  await mkdir(join(hostRoot, 'sessions', slug, 'session-other'), { recursive: true })
  await writeFile(join(hostRoot, 'sessions', slug, 'session-other', 'session.v4.jsonl.zstd'), 'other-log', 'utf8')

  // 投影缓存 + workspace 记账（宿主持有，插件不该碰）
  const projCache = join(hostRoot, 'storages', 'session_projcache', 'sessions', `${agentId}.json`)
  await mkdir(join(hostRoot, 'storages', 'session_projcache', 'sessions'), { recursive: true })
  await writeFile(projCache, JSON.stringify({ title: '不该被删' }), 'utf8')
  const registry = {
    global: { archivedSessionIds: [agentId], pinnedSessionIds: [] },
    tables: { workspaces: { ws1: { sessionIds: [agentId] } } },
  }
  const workspaceJson = join(hostRoot, 'storages', 'workspace.json')
  await writeFile(workspaceJson, JSON.stringify(registry), 'utf8')

  const result = await purgeAgent({ db, root, workspaceId: WORKSPACE, agentId, hostRoot })
  assert.equal(result.sessionFiles, 2)

  // 会话日志（两种命名）都被移除
  await assert.rejects(readFile(join(hostRoot, 'sessions', slug, agentId, 'session.v4.jsonl.zstd'), 'utf8'))
  await assert.rejects(readFile(join(hostRoot, 'sessions', slug, `session-${agentId}`, 'session.v4.jsonl.zstd'), 'utf8'))
  // 别人的不动
  assert.equal(await readFile(join(hostRoot, 'sessions', slug, 'session-other', 'session.v4.jsonl.zstd'), 'utf8'), 'other-log')

  // 投影缓存与 workspace 记账原样保留
  assert.equal(await readFile(projCache, 'utf8'), JSON.stringify({ title: '不该被删' }))
  assert.deepEqual(JSON.parse(await readFile(workspaceJson, 'utf8')), registry)

  // trash 放在 hostRoot 下（sessions/ 之外），不在 sessions/ 里
  await access(join(hostRoot, '.purge-trash'))
  await assert.rejects(access(join(hostRoot, 'sessions', '.purge-trash')))
})

test('purge 不误删另一个工作区里同名人格的绑定记录', async (t) => {
  const db = await openTestDb(t)
  if (db === undefined) return
  const root = await tempRoot(t, 'purge-crossws-')
  const journal = new Journal({ root, deviceId: 'dev-a' })
  await journal.open()
  const identity = new PersonaIdentityStore({ db, journal })

  const OTHER_WS = 'ws-other'

  // 本工作区绑定 + 另一工作区同名人格绑定
  await identity.bindTo('session-a', WORKSPACE, 'lead', 'user')
  await identity.bindTo('session-other', OTHER_WS, 'lead', 'user')

  await purgeAgent({ db, root, workspaceId: WORKSPACE, agentId: 'lead' })

  // DB 层：本工作区绑定清掉，另一工作区绑定原样保留
  assert.equal(identity.resolve('session-a'), 'session-a')
  assert.equal(identity.lookup('session-other')?.personaId, 'lead')

  // journal 层：本工作区的 persona.bind 被物理剔除，另一工作区的保留
  const file = join(root, 'journal', 'devices', 'dev-a', `${new Date().toISOString().slice(0, 10)}.jsonl`)
  const text = await readFile(file, 'utf8')
  assert.equal(text.includes('session-a'), false, '本工作区绑定记录应从 journal 剔除')
  assert.ok(text.includes('session-other'), '另一工作区同名人格绑定必须保留')
})
