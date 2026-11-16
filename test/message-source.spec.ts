/**
 * v4 消息来源单测（test/message-source.spec.ts）
 * ---------------------------------------------------------------------------
 * 宿主的校验很硬：注入消息时 `source.kind` 必须是 `plugin:<插件名>`，
 * 写成旧版裸 `"plugin"` 会被打成
 *
 *     format v4 message requires a producer-owned source kind
 *
 * 这个错误只在"真的往上下文里塞消息"的那一刻才炸，平时跑构建、跑类型检查
 * 都发现不了。所以这里把三条约束钉死：
 *   ① 常量就是宿主认的那个形状；
 *   ② 造出来的 source 通过自身断言（自洽）；
 *   ③ 旧值 `"plugin"`、`"plugin:"`、空串、undefined 一律被拒，
 *      且抛出的错误文案里带上期望值，方便以后排查。
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import {
  PLUGIN_ID,
  PRODUCER_SOURCE_KIND,
  assertProducerSource,
  isProducerSourceKind,
  pluginSource,
  withProducerSource,
} from '../src/shared/message-source.js'

test('来源类型必须是 plugin:<插件名>，且插件名与包名一致', () => {
  assert.equal(PLUGIN_ID, 'dsh-shared-memories')
  assert.equal(PRODUCER_SOURCE_KIND, 'plugin:dsh-shared-memories')
  assert.equal(pluginSource().kind, PRODUCER_SOURCE_KIND)
  assert.equal(pluginSource().plugin, PLUGIN_ID)
})

test('pluginSource() 的产物能通过自身断言（自洽）', () => {
  assert.doesNotThrow(() => assertProducerSource({ source: pluginSource() }))
  assert.doesNotThrow(() => assertProducerSource({ source: { kind: PRODUCER_SOURCE_KIND } }))
})

test('旧版裸 "plugin" 及各种变体必须被拒，并在错误里回显期望值', () => {
  const bad: Array<unknown> = ['plugin', 'plugin:', '', 'PLUGIN:dsh-shared-memories', 'dsh-shared-memories', undefined, null]
  for (const kind of bad) {
    assert.equal(isProducerSourceKind(kind), false, `不应通过：${String(kind)}`)
    assert.throws(
      () => assertProducerSource({ source: { kind } }),
      (error: unknown) =>
        error instanceof Error &&
        error.message.includes('producer-owned source kind') &&
        error.message.includes(PRODUCER_SOURCE_KIND),
      `应抛出带期望值的错误：${String(kind)}`,
    )
  }
})

test('缺 source 也要报错（不能默默放行）', () => {
  assert.throws(() => assertProducerSource({}), /producer-owned source kind/)
})

test('withProducerSource 就地补全，且不破坏其它字段', () => {
  const message: { role: string; content: string; source?: { kind?: unknown } } = {
    role: 'system',
    content: '人格提示',
  }
  const same = withProducerSource(message)
  assert.equal(same, message)
  assert.equal(message.source?.kind, PRODUCER_SOURCE_KIND)
  assert.equal(message.role, 'system')
  assert.doesNotThrow(() => assertProducerSource(message))
})
