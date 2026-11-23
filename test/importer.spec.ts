/**
 * 外部记忆导入（Importer）的行为测试
 * ---------------------------------------------------------------------------
 * 两条回归来自 v0.5.9 终审 P2-3 / P2-4：
 *   - P2-3：format:'auto'（或路由层补的默认值）曾把 auto 当成「已指定格式」，
 *     永远走 Markdown 分支，自动识别形同虚设——JSON 原文被当段落灌进去。
 *   - P2-4：UTF-8 BOM 首字符会废掉 JSON.parse 与 detectFormat 的嗅探。
 */

import assert from 'node:assert/strict'
import type { TestContext } from 'node:test'
import { test } from 'node:test'
import { Importer, detectFormat, parseJson } from '../src/host/memory/importer.js'
import { PoisonGuard } from '../src/host/memory/poison.js'
import { TemporalTree } from '../src/host/memory/timetree.js'
import { Journal } from '../src/shared/journal.js'
import { openTestDb, tempRoot } from './helpers/db.js'

const SCOPE = { workspaceId: 'ws-import', agentId: 'lead', deviceId: 'dev-import' }
const BOM = '\uFEFF'
const JSON_TWO = `[{"text":"用户喜欢咖啡","kind":"preference"},{"text":"用户每天八点起床","kind":"fact"}]`

async function makeImporter(t: TestContext) {
  const db = await openTestDb(t)
  if (!db) return null
  const root = await tempRoot(t)
  const journal = new Journal({ root, deviceId: 'dev-import' })
  await journal.open()
  const tree = new TemporalTree(db, journal)
  const guard = new PoisonGuard({ db, journal })
  return { db, journal, importer: new Importer({ tree, guard, db, journal }) }
}

test('P2-4：BOM 前缀的 JSON 能被 detectFormat 认出来', () => {
  assert.equal(detectFormat(BOM + JSON_TWO), 'json')
  assert.equal(detectFormat(BOM + '# 标题\n- 一条记忆'), 'markdown')
})

test('P2-4：parseJson 剥 BOM 后正常解析两条', () => {
  const items = parseJson(BOM + JSON_TWO)
  assert.equal(items.length, 2)
  assert.equal(items[0]?.kind, 'preference')
  assert.equal(items[0]?.text, '用户喜欢咖啡')
})

test('P2-3：format:auto 走内容嗅探，JSON 原文解析出两条', async (t) => {
  const ctx = await makeImporter(t)
  if (!ctx) return
  const report = await ctx.importer.import({ scope: SCOPE, content: JSON_TWO, format: 'auto' })
  // 走 Markdown 分支只会把整个单行当一条段落；JSON 分支拆出两条。
  assert.equal(report.parsed, 2, `errors=${report.errors.join(' | ')}`)
  assert.equal(report.written, 2)
})

test('P2-3：format 缺省同样嗅探；BOM + JSON 组合下识别与写入都不丢', async (t) => {
  const ctx = await makeImporter(t)
  if (!ctx) return
  const report = await ctx.importer.import({ scope: SCOPE, content: BOM + JSON_TWO })
  assert.equal(report.parsed, 2, `errors=${report.errors.join(' | ')}`)
  assert.equal(report.written, 2)
})

test('显式 format:markdown 仍然生效：JSON 样文本按单段处理', async (t) => {
  const ctx = await makeImporter(t)
  if (!ctx) return
  const report = await ctx.importer.import({ scope: SCOPE, content: JSON_TWO, format: 'markdown' })
  assert.equal(report.parsed, 1)
})

test('写入的条目真的落进时间树，可检索', async (t) => {
  const ctx = await makeImporter(t)
  if (!ctx) return
  await ctx.importer.import({ scope: SCOPE, content: BOM + JSON_TWO, format: 'auto' })
  const rows = ctx.db.all(
    `SELECT e.canonical FROM memory_entity e WHERE e.workspace_id = ? AND e.agent_id = ? ORDER BY e.created_at`,
    [SCOPE.workspaceId, SCOPE.agentId],
  )
  const texts = rows.map((row) => String((row as { canonical?: string }).canonical ?? ''))
  assert.equal(rows.length, 2)
  assert.ok(texts.some((text) => text.includes('咖啡')))
  assert.ok(texts.some((text) => text.includes('八点')))
})

test('V62-10：kind=pitfall 的导入项同时落 pitfall 表（recordPitfall 回调）', async (t) => {
  const db = await openTestDb(t)
  if (!db) return
  const root = await tempRoot(t)
  const journal = new Journal({ root, deviceId: 'dev-import' })
  await journal.open()
  const tree = new TemporalTree(db, journal)
  const guard = new PoisonGuard({ db, journal })
  const recorded: string[] = []
  const importer = new Importer({
    tree,
    guard,
    db,
    journal,
    recordPitfall: async (input) => {
      recorded.push(input.observation)
    },
  })

  const report = await importer.import({
    scope: SCOPE,
    content: '[{"text":"git push 报 409 是分支错位踩的坑","kind":"pitfall"},{"text":"用户喜欢咖啡","kind":"preference"}]',
    format: 'json',
  })
  assert.equal(report.written, 2, `errors=${report.errors.join(' | ')}`)
  assert.equal(recorded.length, 1, '只有 pitfall 项应触发 recordPitfall')
  assert.ok(recorded[0]?.includes('409'), `recorded[0]=${recorded[0]}`)
})

