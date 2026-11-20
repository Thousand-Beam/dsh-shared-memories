/**
 * 噪声记忆自愈（prune-noise）与抽取过滤：单测。
 *
 * 真机事故：召回段里连续六行
 * `- (preference) 3. **再重复一次同一句偏好**…` —— 那是助手写给用户看的操作步骤，
 * 被启发式当成"用户的事实"存进了长期记忆。两条边界必须钉死：
 *   ① 抽取侧：排版行（列表/加粗/代码）与元话语行不进候选；
 *   ② 库里的存量：写 `memory.forget` 墓碑再标死，且**只杀噪声、不碰正经记忆**。
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'

import { openTestDb, tempRoot } from './helpers/db.js'
import { Journal } from '../src/shared/journal.js'
import { TemporalTree } from '../src/host/memory/timetree.js'
import { noiseReason, pruneNoiseMemories } from '../src/host/memory/prune-noise.js'
import { heuristicCandidates } from '../src/host/distill/extract.js'

const WORKSPACE = 'ws-prune'
const PERSONA = 'persona-prune'
const DEVICE = 'dev-a'

test('noiseReason：排版与元话语命中，正经记忆不命中', () => {
  assert.equal(noiseReason('- (preference) 3. **再重复一次同一句偏好**（比如再说一遍「我爱吃鱼」）'), 'layout-list')
  assert.equal(noiseReason('4. `reinforce_count` 应该从 1 变 2'), 'layout-list')
  assert.equal(noiseReason('看记忆总览里那条目不该变成两条'), 'meta')
  assert.equal(noiseReason('千束爱吃清蒸鲈鱼，不吃香菜。'), null)
  assert.equal(noiseReason('项目是 DSH 插件，构建走 tsc + wrap-client'), null)
})

test('noiseReason：含反引号的合法记忆不误杀，超长合法记忆不误杀', () => {
  // 反引号可能是代码/命令，不是 markdown 噪声（真机事故：含 ` 的合法记忆被误删）。
  assert.equal(noiseReason('构建命令是 `npm run build`，产出 lib/client.js。'), null)
  // 超长不是噪声：214 字的踩坑经验是正经记忆，不该被 too-long 判掉。
  const long = '踩坑记录：' + 'x'.repeat(200)
  assert.equal(noiseReason(long), null)
  // 加粗仍是噪声。
  assert.equal(noiseReason('这条 **很重要** 的偏好'), 'layout-markdown')
})

test('pruneNoiseMemories：只遗忘噪声、写墓碑、二次调用归零', async (t) => {
  const db = await openTestDb(t)
  if (db === undefined) return
  const root = await tempRoot(t)
  const journal = new Journal({ root, deviceId: DEVICE })
  await journal.open()
  const tree = new TemporalTree(db, journal)
  const scope = { workspaceId: WORKSPACE, agentId: PERSONA, deviceId: DEVICE }

  await tree.openVersion({
    scope,
    kind: 'preference',
    subjectKey: 'food',
    text: '千束爱吃清蒸鲈鱼，不吃香菜。',
    author: 'user',
    trust: 0.9,
  })
  await tree.openVersion({
    scope,
    kind: 'preference',
    subjectKey: 'noise',
    text: '- (preference) 3. **再重复一次同一句偏好**（比如再说一遍「我爱吃鱼」）',
    author: 'user',
    trust: 0.6,
  })

  const first = await pruneNoiseMemories({ db, journal, clock: () => 1_700_000_000_000 })
  assert.equal(first.scanned, 2)
  assert.equal(first.forgotten, 1)
  assert.deepEqual(first.reasons, { 'layout-list': 1 })

  const kept = db.all<{ canonical: string }>(`SELECT canonical FROM memory_entity WHERE status = 'active'`)
  assert.deepEqual(
    kept.map((row) => row.canonical),
    ['千束爱吃清蒸鲈鱼，不吃香菜。'],
  )

  // 墓碑进 journal：重放时同样保持 forgotten，而不是原地复活。
  const records = await journal.readMerged()
  assert.ok(records.some((record) => record.op === 'memory.forget'))

  const second = await pruneNoiseMemories({ db, journal, clock: () => 1_700_000_001_000 })
  assert.equal(second.forgotten, 0)
})

test('heuristicCandidates：助手回执/排版行/元话语不进候选', () => {
  const turns = [
    { role: 'user' as const, text: '我晚上想吃鲈鱼，我爱吃清蒸鲈鱼，不吃香菜。' },
    { role: 'assistant' as const, text: '3. **再重复一次同一句偏好**（比如再说一遍「我爱吃鱼」），然后看记忆总览。' },
    { role: 'assistant' as const, text: '好，记下了：清蒸鲈鱼不放香菜。' },
  ]
  const candidates = heuristicCandidates(turns)
  assert.equal(candidates.length, 1)
  const [first] = candidates
  assert.ok(first !== undefined)
  assert.match(first.text, /清蒸鲈鱼/)
  assert.equal(first.kind, 'preference')
})

test('heuristicCandidates：召回段整块不进候选（循环繁殖修复）', () => {
  // 召回块 header 曾被 `/(不要…)/` 规则抽成 pitfall，升入规则段后下次召回又召回它，
  // 循环繁殖。header 现在被 RECALL_HEADER 拦、`- (` 内容行被 LAYOUT_NOISE 拦 → 0 候选。
  const turns = [
    {
      role: 'user' as const,
      text:
        '跟当前这句话可能相关的长期记忆（只作背景，不要逐字复述；不确定就说不确定）：\n' +
        '- (fact) 千束爱吃清蒸鲈鱼，不吃香菜。',
    },
  ]
  const candidates = heuristicCandidates(turns)
  assert.equal(candidates.length, 0)
})
