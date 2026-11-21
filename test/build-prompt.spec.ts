/**
 * buildPrompt 回归：生产装配链路必须复用 renderPersona 的单一来源。
 * ---------------------------------------------------------------------------
 * 真机事故（v0.5.1 最终评审 P0-①）：出厂性格/成长观/守候只写进了参照实现
 * `sections.ts`，生产的 `index.ts buildPrompt()` 从不调用 `renderPersona`，
 * 模型首轮 system 只有「名字尚未记录」，根本收不到「刚被点亮不久」那段。
 *
 * 修复后 buildPrompt 直接调 renderPersona。这条测试锁死两件事：
 *   1. buildPrompt 输出含出厂性格/成长观/守候（单一来源文案真的流进生产提示）；
 *   2. 不再出现 buildPrompt 自己写死的「当前智能体：」分支（那条分支就是漏网根因）。
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import { openTestDb } from './helpers/db.js'
import { buildPrompt } from '../src/index.js'

test('buildPrompt 复用 renderPersona：出厂性格/成长观/守候都进提示', async (t) => {
  const db = await openTestDb(t)
  if (db === undefined) return

  const runtime = {
    db,
    workspaceId: 'ws-prompt',
    deviceId: 'devA',
  } as unknown as Parameters<typeof buildPrompt>[0]

  const config = {
    isolation: { allowGlobalSearch: false },
    persona: { baselineNotice: '底线测试' },
  } as unknown as Parameters<typeof buildPrompt>[1]

  const text = buildPrompt(runtime, config, 'default')

  assert.ok(text.includes('刚被点亮不久'), '出厂性格没进提示')
  assert.ok(text.includes('长大'), '成长观没进提示')
  assert.ok(text.includes('守候'), '守候基调没进提示')
  assert.ok(text.includes('不催、不缠'), '守候核心句缺失')
  assert.equal(text.includes('## 当前人格'), false, 'renderPersona 的二级标题没被去掉（双标题）')
  assert.equal(text.includes('当前智能体'), false, '旧的「当前智能体」分支又回来了')
})
