/**
 * 彻底销毁：库与 journal 必须一起清。
 *
 * 这一组测试盯的是"删了但还在"这个最恶心的情况：
 * 只删库 → 下次冷启动 replay 把它重建回来；只删 journal → 库里仍是活的。
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFile, writeFile, mkdir } from 'node:fs/promises'
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
