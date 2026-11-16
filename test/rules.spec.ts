/**
 * 踩坑记录四段演进 + 规则升格的行为测试
 * ---------------------------------------------------------------------------
 * 这组测试盯的是**"谁有权改 System Prompt"**这一条线：
 *
 *   1. 同一个错误犯十次，只是 occurrences +1，不该变成十条记忆
 *   2. `pattern` / `rule` 未经人确认，`injectable()` 一个字都不许吐
 *   3. 升格请求有 TTL —— 点了不确认、过一会儿再点"确认"必须失败
 *   4. 只能升不能降 —— 否则模型可以说服用户"降级一下看看"
 *   5. 确认成功必须留下审计痕迹（audit_log + journal 双写）
 *
 * 第 2 条是这套机制的安全边界：`injectable()` 里那句 `confirmed = 1`
 * 就是"人有没有点头"的唯一判据，测试必须钉死它。
 */

import assert from 'node:assert/strict'
import type { TestContext } from 'node:test'
import { test } from 'node:test'
import { PitfallStore, PitfallError } from '../src/host/memory/pitfall.js'
import { Journal } from '../src/shared/journal.js'
import { openTestDb, tempRoot, hasCode } from './helpers/db.js'

const SCOPE = { workspaceId: 'ws-rules', agentId: 'lead', deviceId: 'dev-a' }

/**
 * 可控时钟：TTL 测试不能靠 `await sleep(600_001)`。
 * 把 `now` 交给测试自己推。
 */
function makeClock(start = 1_700_000_000_000): { now: () => number; advance: (ms: number) => void } {
  let current = start
  return {
    now: () => current,
    advance: (ms: number) => {
      current += ms
    },
  }
}

async function makeStore(t: TestContext, ttlMs = 600_000) {
  const db = await openTestDb(t)
  if (!db) return null
  const root = await tempRoot(t)
  const journal = new Journal({ root, deviceId: 'dev-a' })
  await journal.open()
  const clock = makeClock()
  const store = new PitfallStore({
    db,
    journal,
    approvalTtlMs: ttlMs,
    clock: clock.now,
    onWarn: (message) => {
      throw new Error(`不应出现告警：${message}`)
    },
  })
  return { db, journal, root, store, clock }
}

test('同一个坑记十次只是一条，occurrences 递增', async (t) => {
  const ctx = await makeStore(t)
  if (!ctx) return

  const first = await ctx.store.record({ scope: SCOPE, observation: 'pnpm test 报 ENOENT' })
  assert.equal(first.occurrences, 1)
  assert.equal(first.stage, 'observation')

  const second = await ctx.store.record({ scope: SCOPE, observation: 'pnpm test 报 ENOENT' })
  assert.equal(second.occurrences, 2)
  assert.equal(second.pitfall_id, first.pitfall_id, '同现象必须复用同一行')

  assert.equal(ctx.store.list(SCOPE).length, 1, '清单里只应有一条')
})

test('记录时按已有内容自动推进段位，但 rule 永远停在外面', async (t) => {
  const ctx = await makeStore(t)
  if (!ctx) return

  const bare = await ctx.store.record({ scope: SCOPE, observation: '时间树写入后 valid_until 仍为 NULL' })
  assert.equal(bare.stage, 'observation')

  const withLesson = await ctx.store.record({
    scope: SCOPE,
    observation: '双写不原子',
    lesson: '关闭旧版本与插入新版本必须在同一事务里',
  })
  assert.equal(withLesson.stage, 'lesson')

  const withPattern = await ctx.store.record({
    scope: SCOPE,
    observation: '出现两个活跃版本',
    lesson: '关旧版和新版要同事务',
    pattern: '双写不原子 → uq_version_active 被击穿',
  })
  // 段位可以一次跳到 pattern（那是"描述得够细"），但 confirmed 仍为 0，
  // 所以 injectable() 依然是空的 —— 段位 ≠ 授权。
  assert.equal(withPattern.stage, 'pattern')
  assert.equal(withPattern.confirmed, 0)
  assert.deepEqual(ctx.store.injectable(SCOPE), { rules: [], patterns: [] })
  // record 不接受 rule 参数：升到 rule 只能走 requestPromotion + confirm。
  assert.equal(withPattern.rule, '')
})

test('未确认的 pattern 绝不进 System Prompt', async (t) => {
  const ctx = await makeStore(t)
  if (!ctx) return

  const row = await ctx.store.record({
    scope: SCOPE,
    observation: 'ScopedQuery 忘了拼 workspace_id',
    lesson: '所有查询必须走 #scopeClause',
    pattern: '手写 SQL 直接查表 → 跨工作区泄漏',
  })

  // 即便库里已经有 pattern 文本，只要 confirmed = 0，注入列表就必须是空的。
  const before = ctx.store.injectable(SCOPE)
  assert.deepEqual(before, { rules: [], patterns: [] })

  const request = ctx.store.requestPromotion({
    scope: SCOPE,
    pitfallId: row.pitfall_id,
    to: 'pattern',
  })
  assert.equal(request.to, 'pattern')
  assert.equal(ctx.store.pending().length, 1)

  // 申请阶段不写库：还没点头，System Prompt 一个字节都不许变。
  assert.deepEqual(ctx.store.injectable(SCOPE), { rules: [], patterns: [] })
})

test('确认 pattern 后 confirmed=1 并进入注入列表，同时留下审计', async (t) => {
  const ctx = await makeStore(t)
  if (!ctx) return

  const row = await ctx.store.record({
    scope: SCOPE,
    observation: '恢复完成前就允许新对话',
    lesson: 'agent/created 必须 await barrier.wait()',
  })
  const request = ctx.store.requestPromotion({ scope: SCOPE, pitfallId: row.pitfall_id, to: 'pattern' })
  const confirmedRow = await ctx.store.confirm(request.requestId, 'user', SCOPE)

  assert.equal(confirmedRow.stage, 'pattern')
  assert.equal(confirmedRow.confirmed, 1)

  const injected = ctx.store.injectable(SCOPE)
  assert.deepEqual(injected.patterns, ['agent/created 必须 await barrier.wait()'])
  assert.deepEqual(injected.rules, [])

  const audits = ctx.db.all<{ action: string; detail: string }>(
    `SELECT action, detail FROM audit_log WHERE workspace_id = ? AND agent_id = ?`,
    [SCOPE.workspaceId, SCOPE.agentId],
  )
  assert.equal(audits.length, 1)
  assert.equal(audits[0]?.action, 'pitfall.promote')

  // 请求是一次性的：消费后再确认必须失败。
  await assert.rejects(
    () => ctx.store.confirm(request.requestId, 'user', SCOPE),
    (error: unknown) => hasCode(error, 'promotion-not-found'),
  )
})

test('升格为 rule 但不写规则内容 → 拒绝落库', async (t) => {
  const ctx = await makeStore(t)
  if (!ctx) return

  const row = await ctx.store.record({
    scope: SCOPE,
    observation: '把 token 写进 config 默认值',
    lesson: '凭据一律走 credentialRef',
    pattern: '默认值里出现明文 → 提交即泄漏',
  })
  const request = ctx.store.requestPromotion({ scope: SCOPE, pitfallId: row.pitfall_id, to: 'rule' })

  await assert.rejects(
    () => ctx.store.confirm(request.requestId, 'user', SCOPE),
    (error: unknown) => hasCode(error, 'promotion-empty-rule'),
  )
  assert.equal(ctx.store.injectable(SCOPE).rules.length, 0, '失败后不得留下半条规则')
})

test('升格请求过期即作废，TTL 由服务端记', async (t) => {
  const ctx = await makeStore(t, 60_000)
  if (!ctx) return

  const row = await ctx.store.record({
    scope: SCOPE,
    observation: '快照里漏了 persona 文件',
    lesson: 'collectState 必须覆盖所有活跃 Agent',
  })
  const request = ctx.store.requestPromotion({ scope: SCOPE, pitfallId: row.pitfall_id, to: 'pattern' })

  ctx.clock.advance(60_001)

  await assert.rejects(
    () => ctx.store.confirm(request.requestId, 'user', SCOPE),
    (error: unknown) => hasCode(error, 'promotion-expired'),
  )
  assert.equal(ctx.store.pending().length, 0, '过期请求应从待确认队列里消失')
  assert.equal(ctx.store.list(SCOPE)[0]?.stage, 'lesson', '过期后记录保持原段位')
  assert.equal(ctx.store.list(SCOPE)[0]?.confirmed, 0, '过期后仍然没有注入资格')
})

test('只能升不能降：已是 pattern 的记录拒绝升格到 observation', async (t) => {
  const ctx = await makeStore(t)
  if (!ctx) return

  const row = await ctx.store.record({
    scope: SCOPE,
    observation: 'JSONL 用 fs.writeFile 覆盖写',
    lesson: 'append 必须走追加句柄',
    pattern: '覆盖写 → 上一次快照的日志全丢',
  })
  const promote = ctx.store.requestPromotion({ scope: SCOPE, pitfallId: row.pitfall_id, to: 'pattern' })
  await ctx.store.confirm(promote.requestId, 'user', SCOPE)

  assert.throws(
    () => ctx.store.requestPromotion({ scope: SCOPE, pitfallId: row.pitfall_id, to: 'observation' }),
    (error: unknown) => error instanceof PitfallError && hasCode(error, 'pitfall-stage-regress'),
  )
})

test('不同 agent 的坑互不可见', async (t) => {
  const ctx = await makeStore(t)
  if (!ctx) return

  await ctx.store.record({ scope: SCOPE, observation: 'lead 的坑' })
  await ctx.store.record({
    scope: { ...SCOPE, agentId: 'coder' },
    observation: 'coder 的坑',
  })

  assert.equal(ctx.store.list(SCOPE).length, 1)
  assert.equal(ctx.store.list({ ...SCOPE, agentId: 'coder' }).length, 1)
  assert.equal(ctx.store.list({ ...SCOPE, workspaceId: 'ws-other' }).length, 0, '换工作区必须查不到')
})
