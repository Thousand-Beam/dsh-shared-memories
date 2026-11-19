/**
 * 隔离单测：跨 workspace 查询返回空、跨区写入抛 ScopeViolation、
 * 结果集断言拦截非法数据、全局令牌过期被拒。
 * ---------------------------------------------------------------------------
 * 这一组是"项目串台"的唯一防线。注意断言方向：
 *   - **读**越界 → 返回空（不泄露存在性，也不炸掉对话）
 *   - **写**越界 → 抛错（绝不能悄悄写到别人工作区）
 *   - 结果集越界 → 抛错（手写 SQL 漏 WHERE 时把问题暴露在开发期）
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import { Journal } from '../src/shared/journal.js'
import { TemporalTree } from '../src/host/memory/timetree.js'
import { ScopedQuery } from '../src/host/memory/scoped-query.js'
import { ScopeViolation, isSafeScopeToken, type Scope } from '../src/shared/scope.js'
import { hasCode, openTestDb, tamperRows, tempRoot } from './helpers/db.js'

const NOW = 1_700_000_000_000
const scopePy: Scope = { workspaceId: 'ws_python', agentId: 'agent_fish', deviceId: 'devA' }
const scopeJava: Scope = { workspaceId: 'ws_java', agentId: 'agent_fish', deviceId: 'devA' }

async function seed(t: import('node:test').TestContext) {
  const db = await openTestDb(t)
  if (!db) return undefined
  const root = await tempRoot(t)
  const journal = new Journal({ root, deviceId: 'devA', clock: () => NOW })
  await journal.open()
  const tree = new TemporalTree(db, journal, { clock: () => NOW })
  const opened = await tree.openVersion({
    scope: scopePy,
    kind: 'fact',
    subjectKey: 'project:py-etl/runner',
    text: 'Python 项目的测试用 pytest 跑',
    validFrom: NOW - 1_000,
    author: 'user',
  })
  await journal.flush()
  return { db, root, journal, tree, entityId: opened.entity.entity_id }
}

test('跨 workspace 检索：结果为空，stats 也不泄露对方数据', async (t) => {
  const h = await seed(t)
  if (!h) return

  const other = new ScopedQuery(h.db, scopeJava, { clock: () => NOW })
  const hits = other.search({ text: 'pytest' })
  assert.deepEqual(hits, [])
  assert.deepEqual(other.stats(), { entities: 0, activeVersions: 0 })

  // 同样的查询在"自己的"工作区里必须命中，证明过滤条件是精确的而不是全灭。
  const own = new ScopedQuery(h.db, scopePy, { clock: () => NOW })
  const ownHits = own.search({ text: 'pytest' })
  assert.equal(ownHits.length, 1)
  assert.equal(ownHits[0]?.workspaceId, 'ws_python')
})

test('跨区写入：带别人的 entityId 写版本必须抛 ScopeViolation', async (t) => {
  const h = await seed(t)
  if (!h) return

  await assert.rejects(
    () =>
      h.tree.openVersion({
        scope: scopeJava,
        kind: 'fact',
        subjectKey: 'project:py-etl/runner',
        entityId: h.entityId,
        text: '试图把 Java 项目的事实写进 Python 实体',
        validFrom: NOW,
      }),
    (error: unknown) => {
      assert.ok(error instanceof ScopeViolation, `应抛 ScopeViolation，实际：${String(error)}`)
      assert.equal((error as ScopeViolation).code, 'entity-out-of-scope')
      return true
    },
  )

  // 数据没被污染：原实体仍然只有一条版本。
  const count = h.db.one<{ n: number }>(`SELECT COUNT(*) AS n FROM memory_version WHERE entity_id = ?`, [
    h.entityId,
  ])
  assert.equal(count?.n, 1)
})

test('结果集断言：驱动返回越界行时必须抛 result-out-of-scope', async (t) => {
  const h = await seed(t)
  if (!h) return

  // 模拟"某天有人绕过 #scopeClause 手写 SQL"：行被篡改成别的工作区。
  const leaking = tamperRows(h.db, (row) =>
    typeof row.workspace_id === 'string' ? { ...row, workspace_id: 'ws_leaked' } : row,
  )
  const query = new ScopedQuery(leaking, scopePy, { clock: () => NOW })
  assert.throws(
    () => query.search({}),
    (error: unknown) => hasCode(error, 'result-out-of-scope'),
  )

  // 关掉断言（只应出现在压测/迁移脚本里）时不会抛，但行依旧是错的——所以默认必须开。
  const unguarded = new ScopedQuery(leaking, scopePy, { clock: () => NOW, assertResults: false })
  assert.equal(unguarded.search({}).length, 1)
})

test('全局检索：默认关闭直接拒；开了但令牌过期也拒；有效令牌放行并落审计', async (t) => {
  const h = await seed(t)
  if (!h) return

  // ① 默认配置：连"想全局搜"这个动作都不许发生。
  const strict = new ScopedQuery(h.db, scopePy, { clock: () => NOW })
  assert.throws(
    () =>
      strict.search({
        global: { reason: '排查串台', issuedBy: 'user', issuedAt: NOW, ttlMs: 60_000 },
      }),
    (error: unknown) => hasCode(error, 'global-search-disabled'),
  )

  // ② 开了开关，但令牌已过期。
  const events: Array<{ reason: string; hits: number }> = []
  const open = new ScopedQuery(h.db, scopePy, {
    allowGlobalSearch: true,
    clock: () => NOW,
    onGlobalQuery: (event) => events.push({ reason: event.reason, hits: event.hits }),
  })
  assert.throws(
    () =>
      open.search({
        global: { reason: '跨工作区复盘', issuedBy: 'user', issuedAt: NOW - 120_000, ttlMs: 1_000 },
      }),
    (error: unknown) => hasCode(error, 'global-token-invalid'),
  )
  assert.equal(events.length, 0, '令牌无效时绝不能先查再审计')

  // ③ 有效令牌：能查到别的 workspace，并且必须留审计。
  const globalHits = open.search({
    global: { reason: '跨工作区复盘', issuedBy: 'user', issuedAt: NOW, ttlMs: 60_000 },
  })
  assert.ok(globalHits.length >= 1)
  assert.equal(events.length, 1)
  assert.equal(events[0]?.reason, '跨工作区复盘')
})

test('历史读取：跨工作区读 entity 历史必须抛错，不能返回空（空会被误判为"没历史"）', async (t) => {
  const h = await seed(t)
  if (!h) return

  const other = new ScopedQuery(h.db, scopeJava, { clock: () => NOW })
  assert.throws(
    () => other.history(h.entityId),
    (error: unknown) => hasCode(error, 'entity-out-of-scope'),
  )

  const own = new ScopedQuery(h.db, scopePy, { clock: () => NOW })
  const history = own.history(h.entityId)
  assert.equal(history.length, 1)
  assert.equal(history[0]?.text, 'Python 项目的测试用 pytest 跑')
})

test('isSafeScopeToken：拒绝路径穿越与非法字符', () => {
  // 合法：会话/人格 id（uuid，或带 session- 前缀）。
  assert.equal(isSafeScopeToken('session-2b81896b-f1fb-4fdf-a5e5-ade2c7593654'), true)
  assert.equal(isSafeScopeToken('312561a2-1234-5678-9abc-def012345678'), true)
  assert.equal(isSafeScopeToken('default'), true)
  assert.equal(isSafeScopeToken('agent_fish'), true)

  // 非法：路径穿越、目录分隔符、空白、控制字符、超长、空串。
  assert.equal(isSafeScopeToken('../etc/passwd'), false, '../ 必须拒绝')
  assert.equal(isSafeScopeToken('..'), false, '.. 必须拒绝')
  assert.equal(isSafeScopeToken('a/b'), false, '/ 必须拒绝')
  assert.equal(isSafeScopeToken('a\\b'), false, '\\ 必须拒绝')
  assert.equal(isSafeScopeToken('a b'), false, '空格必须拒绝')
  assert.equal(isSafeScopeToken('a\tb'), false, '制表符必须拒绝')
  assert.equal(isSafeScopeToken(''), false, '空串必须拒绝')
  assert.equal(isSafeScopeToken('x'.repeat(129)), false, '超长（>128）必须拒绝')
})
