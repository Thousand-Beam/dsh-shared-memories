/**
 * Persona 渲染回归测试：**年龄不许进提示**。
 * ---------------------------------------------------------------------------
 * 背景（真机事故）：早期 `renderPersona` 会输出「- 年龄心智：约 10 岁」，
 * 模型于是开始在对话里说「十岁该有的莽」「十岁的设定我理解成……」——
 * 把底层设定当台词念，人物瞬间变成自我介绍机器。
 *
 * 所以这组断言盯的不是"文案好不好看"，而是三条硬约束：
 *   1. 渲染结果里不出现年龄、不出现"岁"字（含中文数字写法）；
 *   2. 特质数值要以"倾向"的身份出现，且带"不要翻译成台词"的约束；
 *   3. 必须有"不主动宣告设定/不做自我介绍"的显式指令。
 *
 * 这类测试的价值在于：**下次谁手一抖把 age 加回去，CI 立刻红。**
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import { renderPersona, type PersonaSnapshot } from '../src/host/prompt/sections.js'
import type { Scope } from '../src/shared/scope.js'

const scope: Scope = { workspaceId: 'ws_render', agentId: 'lead', deviceId: 'devA' }

const persona: PersonaSnapshot = {
  agentId: 'lead',
  name: '小代码酱',
  age: 10,
  traits: { curiosity: 0.82, caution: 0.31, patience: 0.42 },
  workspaceId: 'ws_render',
}

test('renderPersona 绝不把年龄写进提示', () => {
  const text = renderPersona(persona, scope)
  assert.equal(/岁/.test(text), false, `渲染结果里出现了"岁"：\n${text}`)
  assert.equal(text.includes('年龄'), false, '渲染结果里出现了"年龄"')
  assert.equal(text.includes('10'), false, '渲染结果里出现了 age 的具体数值')
  // 中文数字写法也要挡：藏不住的"十岁"最容易骗过正则式的自查
  assert.equal(/十岁|十 岁/.test(text), false, '渲染结果里出现了中文数字年龄')
})

test('renderPersona 把 age 字段当作不存在', () => {
  const withAge = renderPersona(persona, scope)
  const withoutAge = renderPersona({ ...persona, age: undefined }, scope)
  // 摘掉 age 后渲染结果必须逐字相同：age 对提示没有任何影响
  assert.equal(withAge, withoutAge, 'age 字段仍然影响了渲染结果')
})

test('renderPersona 输出名称与倾向，且倾向带"别翻译成台词"的约束', () => {
  const text = renderPersona(persona, scope)
  assert.ok(text.includes('## 当前人格'), '缺少人格段落标题')
  assert.ok(text.includes('小代码酱'), '缺少称呼')
  assert.ok(text.includes('curiosity 0.82'), '缺少特质数值（模型需要知道自己偏什么）')
  assert.ok(text.includes('倾向'), '缺少"倾向"定性说明')
  assert.ok(text.includes('不要'), '缺少负向约束（不要复述数值/不要自我介绍）')
})

test('renderPersona 明确禁止自我介绍式宣告设定', () => {
  const text = renderPersona(persona, scope)
  assert.ok(/不要向用户宣告你的设定/.test(text), '缺少"不要宣告设定"')
  assert.ok(/不谈年纪/.test(text), '缺少"不谈年纪"')
  assert.ok(/不念特质数值/.test(text), '缺少"不念特质数值"')
  assert.ok(/不要罗列设定清单/.test(text), '缺少"被问起时不要罗列清单"')
  assert.ok(/初学者/.test(text), '缺少抽象的"初学者心态"行为基调')
})

test('无 persona 时同样不出现年龄，但仍有行为基调', () => {
  const text = renderPersona(undefined, scope)
  assert.equal(/岁|年龄/.test(text), false, '零人格分支里出现了年龄')
  assert.ok(text.includes('## 当前人格'), '零人格分支缺少标题')
  assert.ok(text.includes('初学者'), '零人格分支缺少行为基调')
})
