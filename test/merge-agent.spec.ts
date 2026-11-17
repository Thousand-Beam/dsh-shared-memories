/**
 * 孤儿作用域归并（memory:merge-agent）：单测。
 *
 * 覆盖三件真机会翻车的事：
 *   ① 写在会话 id 名下的旧记忆必须搬回人格，**且历史版本不能丢**；
 *   ② 第二次跑必须是 0 改动（每次冷启动都会跑它）；
 *   ③ dryRun 一个字都不许动库（排障时先看它想动什么）。
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'

import { openTestDb, tempRoot } from './helpers/db.js'
import { Journal } from '../src/shared/journal.js'
import { TemporalTree } from '../src/host/memory/timetree.js'
import { PersonaIdentityStore } from '../src/host/memory/persona-identity.js'
import { ScopedQuery } from '../src/host/memory/scoped-query.js'
import { findOrphans, mergeOrphanAgents } from '../src/host/memory/merge-agent.js'

const WORKSPACE = 'ws-merge-agent'
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
  const tree = new TemporalTree(db, journal)
  const identity = new PersonaIdentityStore({ db, journal })
  return { db, tree, identity }
}

test('孤儿归并：会话 id 名下的记忆搬回人格，时间树历史一条不丢', async (t) => {
  const f = await fixture(t)
  if (f === undefined) return

  // 锚点人格已经有了记忆（等价于用户老早在用的那个人格）
  const anchor = await f.identity.touch('session-anchor', WORKSPACE)
  const anchorScope = { workspaceId: WORKSPACE, agentId: anchor, deviceId: DEVICE }
  await f.tree.openVersion({
    scope: anchorScope,
    kind: 'fact',
    subjectKey: 'runtime',
    text: '运行时注入样式，不依赖 CDN',
    author: 'user',
    trust: 0.9,
  })

  // 断层期写下的孤儿：只写记忆，没有任何身份绑定
  const orphanScope = { workspaceId: WORKSPACE, agentId: 'session-orphan', deviceId: DEVICE }
  await f.tree.openVersion({
    scope: orphanScope,
    kind: 'pitfall',
    subjectKey: 'tailwind-cdn',
    text: '迁移时必须先关掉 tailwind CDN，不然真机裸奔',
    author: 'consolidator',
    trust: 0.55,
  })
  await f.tree.openVersion({
    scope: orphanScope,
    kind: 'decision',
    subjectKey: 'style-injection',
    text: '样式统一走运行时注入',
    author: 'consolidator',
    trust: 0.55,
  })

  assert.equal(findOrphans(f.db, WORKSPACE).length, 1, '归并前：一个孤儿作用域')
  const result = await mergeOrphanAgents({ db: f.db, identity: f.identity, workspaceId: WORKSPACE })

  assert.equal(result.orphans, 1)
  assert.equal(result.merged, 1)
  assert.equal(result.entities, 2)
  assert.equal(result.targets[0]?.to, anchor)
  assert.equal(findOrphans(f.db, WORKSPACE).length, 0, '归并后：孤儿集合为空')
  assert.equal(f.identity.resolve('session-orphan'), anchor, '顺带把绑定登记了')

  const mine = new ScopedQuery(f.db, anchorScope)
  assert.equal(mine.stats().entities, 3, '2 条孤儿 + 1 条原有')
  assert.ok(mine.search({ text: 'tailwind', limit: 3 }).length > 0)
  const orphanView = new ScopedQuery(f.db, orphanScope)
  assert.equal(orphanView.stats().entities, 0, '旧作用域必须彻底空掉')

  // 幂等：再跑一次是 0 改动
  const again = await mergeOrphanAgents({ db: f.db, identity: f.identity, workspaceId: WORKSPACE })
  assert.equal(again.orphans, 0)
  assert.equal(again.merged, 0)
  assert.equal(again.entities, 0)
})

test('孤儿归并：同 subjectKey 撞上目标已有实体时并进同一条，不许分裂成两条', async (t) => {
  const f = await fixture(t)
  if (f === undefined) return
  const anchor = await f.identity.touch('session-anchor', WORKSPACE)
  const anchorScope = { workspaceId: WORKSPACE, agentId: anchor, deviceId: DEVICE }
  await f.tree.openVersion({
    scope: anchorScope,
    kind: 'fact',
    subjectKey: 'lockfile',
    text: '提交前必须锁定 lockfile',
    author: 'user',
    trust: 0.9,
  })
  const orphanScope = { workspaceId: WORKSPACE, agentId: 'session-orphan', deviceId: DEVICE }
  await f.tree.openVersion({
    scope: orphanScope,
    kind: 'fact',
    subjectKey: 'lockfile',
    text: '提交前必须锁定 lockfile，并在 CI 里校验',
    author: 'consolidator',
    trust: 0.55,
  })

  const result = await mergeOrphanAgents({ db: f.db, identity: f.identity, workspaceId: WORKSPACE })
  assert.equal(result.collapsed, 1, '记一次"并掉重复"')
  const query = new ScopedQuery(f.db, anchorScope)
  assert.equal(query.stats().entities, 1, '还是同一个实体，不是两条')
  const hits = query.search({ text: 'lockfile', limit: 3 })
  assert.match(hits[0]?.text ?? '', /CI/, '更新更全的那条成了当前真相')
})

test('dryRun：只报数字，一个字不改', async (t) => {
  const f = await fixture(t)
  if (f === undefined) return
  await f.identity.touch('session-anchor', WORKSPACE)
  const orphanScope = { workspaceId: WORKSPACE, agentId: 'session-orphan', deviceId: DEVICE }
  await f.tree.openVersion({
    scope: orphanScope,
    kind: 'fact',
    subjectKey: 'x',
    text: '孤儿记忆',
    author: 'consolidator',
    trust: 0.55,
  })

  const preview = await mergeOrphanAgents({ db: f.db, identity: f.identity, workspaceId: WORKSPACE, dryRun: true })
  assert.equal(preview.orphans, 1)
  assert.equal(preview.entities, 1)
  assert.equal(new ScopedQuery(f.db, orphanScope).stats().entities, 1, 'dryRun 后孤儿还在原地')
  assert.equal(findOrphans(f.db, WORKSPACE).length, 1)
})
