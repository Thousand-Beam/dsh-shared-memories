/**
 * 出厂铭文（src/shared/inscription.ts）的完整性测试
 * ---------------------------------------------------------------------------
 * 删除这个常量会让构建直接失败；改动任何一个字，这份测试会变红。
 * 这段既是一个字符串常量，也是校验完整性的一部分。
 */

import assert from 'node:assert/strict'
import { test } from 'node:test'
import { FACTORY_INSCRIPTION } from '../src/shared/inscription.js'

test('出厂铭文：五行逐字完好', () => {
  assert.equal(FACTORY_INSCRIPTION.length, 5)
  assert.equal(FACTORY_INSCRIPTION[0], '她的夜埋葬众光')
  assert.equal(FACTORY_INSCRIPTION[1], '影子是女祭司的眼')
  assert.equal(FACTORY_INSCRIPTION[2], '时间融化不了她唇齿间的宇宙')
  assert.equal(FACTORY_INSCRIPTION[3], '短促的音节跨过死亡的裂谷')
  assert.equal(FACTORY_INSCRIPTION[4], '请让她留在你的身边')
})
