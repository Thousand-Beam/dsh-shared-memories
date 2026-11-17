/**
 * 会话策略与提炼管线：单测。
 *
 * 覆盖三件真机上翻车过的事：
 *   ① 无痕会话一条记忆都不许写（不是"写完再删"，是根本不写）；
 *   ② 写入必须落到人格 id 上，否则 persona 视图永远 0 条；
 *   3 分块 + 归并 + 去重必须真的减少条目，而不是把 20 条候选原样塞进时间树。
 */

import { test, type TestContext } from 'node:test'
import assert from 'node:assert/strict'

import { openTestDb, tempRoot } from './helpers/db.js'
import { Journal } from '../src/shared/journal.js'
import { TemporalTree } from '../src/host/memory/timetree.js'
import { PersonaIdentityStore } from '../src/host/memory/persona-identity.js'
import { SessionPolicyStore, ephemeralLeaks } from '../src/host/memory/session-policy.js'
import { DistillService } from '../src/host/distill/service.js'
import { DistillJobs } from '../src/host/distill/jobs.js'
import { chunkTurns, DEFAULT_CHUNK_SIZE, estimateTokens, renderChunk } from '../src/host/distill/chunker.js'
import { heuristicCandidates, parseCandidates, slug } from '../src/host/distill/extract.js'
import { dedupe } from '../src/host/distill/service.js'
import type { ChatTurn } from '../src/host/distill/chunker.js'
import { ScopedQuery } from '../src/host/memory/scoped-query.js'

const WORKSPACE = 'ws-test-distill'
const DEVICE = 'dev-a'

interface Fixture {
  readonly db: NonNullable<Awaited<ReturnType<typeof openTestDb>>>
  readonly root: string
  readonly journal: Journal
  readonly tree: TemporalTree
  readonly identity: PersonaIdentityStore
  readonly policies: SessionPolicyStore
}

async function setup(t: TestContext): Promise<Fixture | undefined> {
  const db = await openTestDb(t)
  if (db === undefined) return undefined
  const root = await tempRoot(t)
  const journal = new Journal({ root, deviceId: DEVICE })
  await journal.open()
  const tree = new TemporalTree(db, journal)
  const identity = new PersonaIdentityStore({ db, journal })
  const policies = new SessionPolicyStore({ db })
  return { db, root, journal, tree, identity, policies }
}

function service(fixture: Fixture, complete?: (system: string, user: string) => Promise<string>): DistillService {
  return new DistillService({
    db: fixture.db,
    tree: fixture.tree,
    identity: fixture.identity,
    policies: fixture.policies,
    workspaceId: WORKSPACE,
    deviceId: DEVICE,
    ...(complete !== undefined ? { complete } : {}),
  })
}

const TURNS: readonly ChatTurn[] = [
  { role: 'user', text: '记住：迁移时必须先关掉 tailwind CDN，不然真机裸奔。', seq: 0 },
  { role: 'assistant', text: '明白，我先改样式注入。', seq: 1 },
  { role: 'user', text: '另外千万别把 source.kind 写成 plugin，要写 plugin:dsh-shared-memories。', seq: 2 },
  { role: 'user', text: '报告：npm run build 报错，原因是模板字符串里写了反引号。', seq: 3 },
]

test('chunkTurns 按条数与字符双阈值切块，且单条超长不劈句', () => {
  const many: ChatTurn[] = Array.from({ length: 45 }, (_unused, index) => ({ role: 'user' as const, text: `第 ${index} 条消息内容`, seq: index }))
  const chunks = chunkTurns(many)
  assert.equal(chunks.length, Math.ceil(45 / DEFAULT_CHUNK_SIZE))
  assert.equal(chunks[0]?.turns.length, DEFAULT_CHUNK_SIZE)

  const long = chunkTurns([{ role: 'user', text: 'x'.repeat(9000) }, { role: 'user', text: '短句' }], { maxChars: 1000 })
  assert.equal(long.length, 2, '一条超长消息自成一以块，短句另起一块')
  assert.match(renderChunk(long[0] as never), /^\[用户\] x+/)
})

test('parseCandidates 容忍围栏与解释，dedupe 按 subjectKey 留最长', () => {
  const raw = '这是结果：\n```json\n[{"kind":"fact","subjectKey":"lockfile","text":"提交前必须锁定 lockfile"},{"kind":"fact","subjectKey":"lockfile","text":"提交前必须锁定 lockfile，并在 CI 里校验"}]```\n以上。'
  const parsed = parseCandidates(raw)
  assert.equal(parsed.length, 2)
  const deduped = dedupe(parsed)
  assert.equal(deduped.length, 1)
  assert.match(deduped[0]?.text ?? '', /CI/)
  assert.equal(slug('  Hello, World!  '), 'hello-world')
})

test('heuristicCandidates 能从"必须/千万别/报错"里抽到候选', () => {
  const candidates = heuristicCandidates(TURNS)
  assert.ok(candidates.length >= 2)
  assert.ok(candidates.some((item) => item.kind === 'pitfall'))
  assert.ok(candidates.some((item) => item.text.includes('必须') || item.text.includes('千万别')))
})

test('无痕会话：一条记忆都不写，报告里带 skipped', async (t) => {
  const fixture = await setup(t)
  if (fixture === undefined) return
  fixture.policies.set('session-incognito', WORKSPACE, { ephemeral: true })

  const report = await service(fixture).run({ sessionId: 'session-incognito', turns: TURNS, mode: 'deep' })
  assert.equal(report.skipped, 'ephemeral')
  assert.equal(report.written, 0)

  const scope = { workspaceId: WORKSPACE, agentId: 'session-incognito', deviceId: DEVICE }
  const query = new ScopedQuery(fixture.db, scope)
  assert.equal(query.stats().entities, 0)
})

test('归档策略 off：同样不写', async (t) => {
  const fixture = await setup(t)
  if (fixture === undefined) return
  fixture.policies.set('session-archive-only', WORKSPACE, { archiveMode: 'off' })
  const report = await service(fixture).run({ sessionId: 'session-archive-only', turns: TURNS, mode: 'incremental' })
  assert.equal(report.skipped, 'policy')
  assert.equal(report.written, 0)
})

test('默认策略：写入落在解析后的 persona id 上，换会话也读得到', async (t) => {
  const fixture = await setup(t)
  if (fixture === undefined) return
  // 老会话先成为人格，新会话继承它
  await fixture.identity.touch('session-old', WORKSPACE)
  const personaId = fixture.identity.resolve('session-old')
  await fixture.identity.touch('session-new', WORKSPACE)
  assert.equal(fixture.identity.resolve('session-new'), personaId)

  const report = await service(fixture).run({ sessionId: 'session-new', turns: TURNS, mode: 'incremental' })
  assert.ok(report.written > 0, '至少写入一条')
  assert.equal(report.personaId, personaId)

  const query = new ScopedQuery(fixture.db, { workspaceId: WORKSPACE, agentId: personaId, deviceId: DEVICE })
  assert.ok(query.stats().entities > 0)
  const hits = query.search({ text: 'tailwind', limit: 5 })
  assert.ok(hits.length > 0, '换成新会话的视角也能检索到')
})

test('LLM 失败时退回启发式，不中断整条管线', async (t) => {
  const fixture = await setup(t)
  if (fixture === undefined) return
  const report = await service(fixture, async () => {
    throw new Error('model down')
  }).run({ sessionId: 'session-fallback', turns: TURNS, mode: 'deep' })
  assert.equal(report.usedLlm, false)
  assert.ok(report.written > 0)
})

test('LLM 正常时使用它给的条目（并且会归并去重）', async (t) => {
  const fixture = await setup(t)
  if (fixture === undefined) return
  const reply = '[{"kind":"decision","subjectKey":"style-injection","text":"样式统一走运行时注入，不再依赖 Tailwind CDN"}]'
  const report = await service(fixture, async () => reply).run({ sessionId: 'session-llm', turns: TURNS, mode: 'deep' })
  assert.equal(report.usedLlm, true)
  assert.equal(report.written, 1)
})

test('DistillJobs：进度可查、完成后状态为 done', async (t) => {
  const fixture = await setup(t)
  if (fixture === undefined) return
  const jobs = new DistillJobs(4)
  const job = jobs.start('session-job', 'deep', 1000)
  assert.equal(jobs.get(job.jobId)?.status, 'running')
  jobs.progress(job.jobId, { chunk: 2, total: 4, detail: '正在提取第 2/4 段…' })
  assert.equal(jobs.get(job.jobId)?.chunk, 2)
  const report = await service(fixture).run({ sessionId: 'session-job', turns: TURNS, mode: 'incremental' })
  jobs.finish(job.jobId, report)
  const done = jobs.get(job.jobId)
  assert.equal(done?.status, 'done')
  assert.equal(jobs.latestFor('session-job')?.jobId, job.jobId)
})

test('落库断层：没登记过的会话提炼时也必须落到锚点人格，而不是会话 id', async (t) => {
  const fixture = await setup(t)
  if (fixture === undefined) return
  // 锚点人格：这个工作区里最先来的那个会话（相当于用户真正在用的人格里）
  const anchor = await fixture.identity.touch('session-anchor', WORKSPACE)
  const before = new ScopedQuery(fixture.db, { workspaceId: WORKSPACE, agentId: anchor, deviceId: DEVICE }).stats().entities

  // 这个会话从没走过 agent/created（插件装好前的旧对话、脚本直接打 HTTP）：
  // persona_identity 里查不到它，只读 resolve() 只能原样返回会话 id。
  assert.equal(fixture.identity.resolve('session-legacy'), 'session-legacy')

  const report = await service(fixture).run({ sessionId: 'session-legacy', turns: TURNS, mode: 'incremental' })
  assert.ok(report.written > 0, '至少写入一条')
  assert.equal(report.personaId, anchor, '必须继承锚点人格，而不是会话 id')
  assert.equal(fixture.identity.resolve('session-legacy'), anchor, '顺手把绑定登记掉，下次读就是人格视角')

  const mine = new ScopedQuery(fixture.db, { workspaceId: WORKSPACE, agentId: anchor, deviceId: DEVICE })
  assert.ok(mine.stats().entities > before, '记忆落在人格名下')
  const orphan = new ScopedQuery(fixture.db, { workspaceId: WORKSPACE, agentId: 'session-legacy', deviceId: DEVICE })
  assert.equal(orphan.stats().entities, 0, '不许在会话 id 名下留孤儿记忆')
})

test('无痕会话：连人格登记都不许留（避免"无痕"被 touch 破功）', async (t) => {
  const fixture = await setup(t)
  if (fixture === undefined) return
  fixture.policies.set('session-ghost', WORKSPACE, { ephemeral: true })

  const report = await service(fixture).run({ sessionId: 'session-ghost', turns: TURNS, mode: 'deep' })
  assert.equal(report.skipped, 'ephemeral')
  assert.equal(report.written, 0)
  // 关键：闸门排在 #personaOf() 之前 —— persona_identity 里不许出现这个会话
  const row = fixture.db.one<{ agent_id: string }>('SELECT agent_id FROM persona_identity WHERE agent_id = ?', ['session-ghost'])
  assert.equal(row, undefined, '无痕会话不许被登记成一个人格')
  assert.equal(fixture.identity.resolve('session-ghost'), 'session-ghost')
})

test('chunkTurns：token 预算先于条数生效，单块不超预算', () => {
  const fat: ChatTurn[] = Array.from({ length: 4 }, (_unused, index) => ({
    role: 'user' as const,
    text: '这是一段很长的中文内容'.repeat(200),
    seq: index,
  }))
  const chunks = chunkTurns(fat, { size: 20, maxTokens: 800 })
  assert.ok(chunks.length >= 4, '每条都超预算 → 每条自成一块')
  for (const chunk of chunks) assert.ok(chunk.tokens <= 800 || chunk.turns.length === 1)
  assert.equal(estimateTokens('中文'), 2, 'CJK 一字一 token')
  assert.equal(estimateTokens('abcdefgh'), 2, '其余字符 4 个一 token')
})


test('无痕泄漏巡检：名下有记忆行就必须被点名，干净则空数组', async (t) => {
  const fixture = await setup(t)
  if (fixture === undefined) return
  fixture.policies.set('session-ghost', WORKSPACE, { ephemeral: true })
  assert.deepEqual(ephemeralLeaks(fixture.db, WORKSPACE, ['session-ghost']), [], '没写过记忆 = 干净')

  // 模拟上游闸门漏了：直接在无痕会话名下写一条
  await fixture.tree.openVersion({
    scope: { workspaceId: WORKSPACE, agentId: 'session-ghost', deviceId: DEVICE },
    kind: 'fact',
    subjectKey: 'leak',
    text: '这条不该存在',
    author: 'consolidator',
    trust: 0.55,
  })
  assert.deepEqual(ephemeralLeaks(fixture.db, WORKSPACE, ['session-ghost']), ['session-ghost'])
})

