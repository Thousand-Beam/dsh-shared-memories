/**
 * 提炼水位（distill cursor）：边聊边记的"上次记到哪儿"。
 *
 * 真机事故回顾：记忆只有一个写入入口 —— 归档（`workspace/session-stop`）。
 * 用户只聊天、从不归档，`memory_entity` 永远是 0 行，面板上写"这个 Agent
 * 还没有任何记忆"。要边聊边记，就必须能回答"这段对话提炼过没有"。
 *
 * 这里钉死三条边界：
 *   ① 没记过 = 0（整段都算新内容）；
 *   ② 水位只增不减（两路提炼并发时，晚到的不能把水位往回拨）；
 *   ③ 会话销毁时清水位（否则重开同名会话以为已经记过了）。
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'

import { openTestDb } from './helpers/db.js'
import { DistillCursor } from '../src/host/distill/cursor.js'

const WORKSPACE = 'ws-cursor'

test('水位：没记过返回 0，写过之后原样读回', async (t) => {
  const db = await openTestDb(t)
  if (db === undefined) return
  let now = 1_700_000_000_000
  const cursor = new DistillCursor({ db, clock: () => now })

  assert.equal(cursor.get('session-a'), 0)

  cursor.set('session-a', WORKSPACE, 7)
  assert.equal(cursor.get('session-a'), 7)

  // 下一个会话互不影响
  assert.equal(cursor.get('session-b'), 0)

  now += 1000
  cursor.set('session-a', WORKSPACE, 12)
  assert.equal(cursor.get('session-a'), 12)

  const row = db.one<{ distilled_turns: number; updated_at: number; workspace_id: string }>(
    'SELECT distilled_turns, updated_at, workspace_id FROM distill_cursor WHERE session_id = ?',
    ['session-a'],
  )
  assert.equal(row?.distilled_turns, 12)
  assert.equal(row?.workspace_id, WORKSPACE)
  assert.equal(row?.updated_at, now, '时间戳应该跟着写入走')
})

test('水位只增不减：并发提炼里晚到的那次不能回拨', async (t) => {
  const db = await openTestDb(t)
  if (db === undefined) return
  const cursor = new DistillCursor({ db })

  cursor.set('session-a', WORKSPACE, 20)
  // 另一路拿着更旧的读数（比如 5 条）跑完，不该把水位退回去
  cursor.set('session-a', WORKSPACE, 5)
  assert.equal(cursor.get('session-a'), 20)

  // 非法值直接忽略，不写脏数据
  cursor.set('session-a', WORKSPACE, 0)
  cursor.set('session-a', WORKSPACE, Number.NaN)
  cursor.set('', WORKSPACE, 30)
  assert.equal(cursor.get('session-a'), 20)
  assert.equal(cursor.get(''), 0)
})

test('销毁会话时水位一起清掉，重开同名会话从 0 开始', async (t) => {
  const db = await openTestDb(t)
  if (db === undefined) return
  const cursor = new DistillCursor({ db })

  cursor.set('session-a', WORKSPACE, 9)
  assert.equal(cursor.get('session-a'), 9)

  cursor.clear('session-a')
  assert.equal(cursor.get('session-a'), 0)

  const rows = db.all('SELECT session_id FROM distill_cursor')
  assert.equal(rows.length, 0)
})
