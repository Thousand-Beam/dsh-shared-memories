/**
 * 逐轮召回：让记忆真的按"当前这句话"进提示词。
 *
 * 真机事故回顾：面板里明明有记忆，问"你爱吃什么"却答不出来。根因不是检索算法差，
 * 而是**根本没有检索** —— 记忆段在组装期算一次、按人格缓存，整场对话看到同一批。
 *
 * 这里钉死四条边界：
 *   ① 关键词命中的排在无关记忆前面（相关性优先，不是"最新的赢"）；
 *   ② 复现次数（reinforce_count）参与加权：说过三遍的偏好压过只说一次的细节；
 *   ③ 硬字符预算：超预算一律裁掉（提示词撑爆比少召回更糟）；
 *   ④ 渲染必须净化 `{{` —— 宿主插值遇到未知变量会直接抛错，一条用户记忆能炸掉整轮。
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'

import { openTestDb, tempRoot } from './helpers/db.js'
import { Journal } from '../src/shared/journal.js'
import { TemporalTree } from '../src/host/memory/timetree.js'
import { markRecalled, recallMemories, renderRecallBlock } from '../src/host/memory/recall.js'
import type { MemoryKind, SqlDriver } from '../src/shared/types.js'
import type { Scope } from '../src/shared/scope.js'

const WORKSPACE = 'ws-recall'
const AGENT = 'persona-recall'
const DEVICE = 'test-device'
const SCOPE: Scope = { workspaceId: WORKSPACE, agentId: AGENT, deviceId: DEVICE }
const NOW = 1_700_000_000_000

interface Seed {
  readonly id: string
  readonly kind: MemoryKind
  readonly subjectKey: string
  readonly text: string
  readonly salience?: number
  readonly trust?: number
  readonly reinforceCount?: number
  readonly pinned?: number
  readonly validFrom?: number
}

/** 直接写库（绕开 TemporalTree 的 journal），只为验证召回排序。 */
function seed(db: SqlDriver, input: Seed): void {
  const at = input.validFrom ?? NOW
  db.run(
    `INSERT INTO memory_entity (
       entity_id, workspace_id, agent_id, kind, subject_key, canonical,
       salience, trust, status, content_hash, created_at, updated_at,
       last_recalled_at, reinforce_count, pinned, device_id
     ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    [
      input.id,
      WORKSPACE,
      AGENT,
      input.kind,
      input.subjectKey,
      input.text,
      input.salience ?? 0.6,
      input.trust ?? 0.9,
      'active',
      `hash-${input.id}`,
      at,
      at,
      0,
      input.reinforceCount ?? 1,
      input.pinned ?? 0,
      DEVICE,
    ],
  )
  db.run(
    `INSERT INTO memory_version (
       version_id, entity_id, seq, valid_from, valid_until, text,
       emo_subject, emo_trigger, emo_label, emo_intensity, emo_confidence,
       source_session_id, source_seq_start, source_seq_end,
       distill_status, distill_model, supersedes, author, device_id, created_at
     ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    [
      `ver-${input.id}`,
      input.id,
      1,
      at,
      null,
      input.text,
      null,
      null,
      null,
      null,
      null,
      null,
      null,
      null,
      'distilled',
      'heuristic',
      null,
      'user',
      DEVICE,
      at,
    ],
  )
}

test('召回：关键词命中的记忆排在无关记忆前面', async (t) => {
  const db = await openTestDb(t)
  if (db === undefined) return
  seed(db, { id: 'e-fish', kind: 'preference', subjectKey: 'food/likes', text: '千束爱吃清蒸鲈鱼，不吃香菜。' })
  seed(db, { id: 'e-build', kind: 'pitfall', subjectKey: 'build/tsc', text: 'tsconfig 里必须开 nodenext，否则 ESM 解析失败。' })
  seed(db, { id: 'e-misc', kind: 'fact', subjectKey: 'misc', text: '今天是周三。', salience: 0.1, trust: 0.3 })

  const hits = recallMemories(db, SCOPE, '我晚上想吃鲈鱼，你记得我爱吃什么吗', { now: NOW })
  assert.ok(hits.length >= 1, '至少要召回一条')
  assert.equal(hits[0]?.entityId, 'e-fish', '偏好的那条必须排第一')
  assert.ok(hits.every((hit) => hit.entityId !== 'e-misc'), '低显著度且无关的记忆不该混进来')
})

test('召回：复现次数参与加权，说过三遍的压过只说一次的', async (t) => {
  const db = await openTestDb(t)
  if (db === undefined) return
  // 两条都能命中同一个词，唯一差别是 reinforce_count
  seed(db, { id: 'e-once', kind: 'preference', subjectKey: 'drink/once', text: '他偶尔喝咖啡。', reinforceCount: 1 })
  seed(db, { id: 'e-thrice', kind: 'preference', subjectKey: 'drink/thrice', text: '他每天都要喝咖啡。', reinforceCount: 4 })

  const hits = recallMemories(db, SCOPE, '咖啡', { now: NOW })
  assert.equal(hits[0]?.entityId, 'e-thrice', '复现次数高的应该排前面')
})

test('召回：硬字符预算生效，置顶条目不受预算限制', async (t) => {
  const db = await openTestDb(t)
  if (db === undefined) return
  const long = '这是一条很长的记忆正文，'.repeat(20)
  seed(db, { id: 'e-a', kind: 'fact', subjectKey: 'a', text: `${long}A`, validFrom: NOW })
  seed(db, { id: 'e-b', kind: 'fact', subjectKey: 'b', text: `${long}B`, validFrom: NOW - 1000 })
  seed(db, { id: 'e-pin', kind: 'persona', subjectKey: 'pin', text: '置顶：叫他千束。', pinned: 1, validFrom: NOW - 5000 })

  const hits = recallMemories(db, SCOPE, '', { now: NOW, budgetChars: 200, limit: 10 })
  const pinned = hits.filter((hit) => hit.pinned)
  assert.equal(pinned.length, 1, '置顶必须在结果里')
  const unpinnedChars = hits.filter((hit) => !hit.pinned).reduce((sum, hit) => sum + hit.text.length, 0)
  assert.ok(unpinnedChars <= 200, `非置顶条目总字符必须 <= 预算，实际 ${unpinnedChars}`)
})

test('渲染：空结果返回空串，正文里的 {{ 被净化', async (t) => {
  const db = await openTestDb(t)
  if (db === undefined) return
  assert.equal(renderRecallBlock([]), '', '零条目 = 零 token')

  seed(db, { id: 'e-tpl', kind: 'fact', subjectKey: 'template', text: '模板里写 {{sessionId}} 会被宿主插值。' })
  const [hit] = recallMemories(db, SCOPE, '模板', { now: NOW })
  assert.ok(hit !== undefined)
  const rendered = renderRecallBlock([hit])
  assert.ok(rendered.includes('{ {sessionId} }'), '双大括号必须被打散')
  assert.ok(!/\{\{/.test(rendered), '渲染结果里不能残留 {{')
})

test('召回：读不到当前句子时退化成热记忆（近期 + 置顶），而不是空手', async (t) => {
  const db = await openTestDb(t)
  if (db === undefined) return
  seed(db, { id: 'e-hot', kind: 'preference', subjectKey: 'hot', text: '他喜欢简短的回答。', validFrom: NOW - 60_000 })
  seed(db, { id: 'e-cold', kind: 'fact', subjectKey: 'cold', text: '很久以前的一条旧事。', validFrom: NOW - 400 * 24 * 3600 * 1000 })

  const hits = recallMemories(db, SCOPE, '', { now: NOW, limit: 3 })
  assert.ok(hits.length >= 1, '空查询也要能带回热记忆')
  assert.equal(hits[0]?.entityId, 'e-hot', '近期的排在陈旧的之前')
})

test('markRecalled 只更新命中条目的 last_recalled_at', async (t) => {
  const db = await openTestDb(t)
  if (db === undefined) return
  seed(db, { id: 'e-hit', kind: 'fact', subjectKey: 'hit', text: '被用到的一条。' })
  seed(db, { id: 'e-idle', kind: 'fact', subjectKey: 'idle', text: '没被用到的。' })

  markRecalled(db, ['e-hit'], NOW)
  const hit = db.one<{ last_recalled_at: number }>('SELECT last_recalled_at FROM memory_entity WHERE entity_id = ?', ['e-hit'])
  const idle = db.one<{ last_recalled_at: number }>('SELECT last_recalled_at FROM memory_entity WHERE entity_id = ?', ['e-idle'])
  assert.equal(hit?.last_recalled_at, NOW)
  assert.equal(idle?.last_recalled_at, 0)
})

test('复现确认：同一句话写第二次时 reinforce_count 加一，但不产生新版本', async (t) => {
  const db = await openTestDb(t)
  if (db === undefined) return
  const root = await tempRoot(t)
  const tree = new TemporalTree(db, new Journal({ root, deviceId: DEVICE }))

  const first = await tree.openVersion({ scope: SCOPE, kind: 'preference', subjectKey: 'food/likes', text: '爱吃鲈鱼。' })
  assert.equal(first.deduped, false)

  const second = await tree.openVersion({ scope: SCOPE, kind: 'preference', subjectKey: 'food/likes', text: '爱吃鲈鱼。' })
  assert.equal(second.deduped, true, '同样的正文不该产生新版本')

  const row = db.one<{ reinforce_count: number }>('SELECT reinforce_count FROM memory_entity WHERE entity_id = ?', [first.entity.entity_id])
  assert.equal(row?.reinforce_count, 2, '说过两遍就该记两次')
  const versions = db.all('SELECT version_id FROM memory_version WHERE entity_id = ?', [first.entity.entity_id])
  assert.equal(versions.length, 1)
})

test('reinforce_count 封顶 64：异常循环刷不会让计数与召回展示无限膨胀（终审报告 P3）', async (t) => {
  const db = await openTestDb(t)
  if (db === undefined) return
  const root = await tempRoot(t)
  const tree = new TemporalTree(db, new Journal({ root, deviceId: DEVICE }))

  const first = await tree.openVersion({ scope: SCOPE, kind: 'preference', subjectKey: 'food/likes', text: '爱吃鲈鱼。' })
  for (let i = 0; i < 100; i++) {
    await tree.openVersion({ scope: SCOPE, kind: 'preference', subjectKey: 'food/likes', text: '爱吃鲈鱼。' })
  }

  const row = db.one<{ reinforce_count: number }>(
    'SELECT reinforce_count FROM memory_entity WHERE entity_id = ?',
    [first.entity.entity_id],
  )
  assert.equal(row?.reinforce_count, 64, '计数封顶 64（召回权重 log2 在此已饱和，再高只是展示数字膨胀）')
})
