/**
 * 情感闸门单测：低置信度丢弃、非法 label 丢弃、字段缺失丢弃、合格则原样入库。
 * ---------------------------------------------------------------------------
 * PRD 6 的硬要求：**宁可不记情绪，也不要记错情绪**。
 * 所以这里的每个用例都在验证"整块置 null"这一条，而不是"部分字段能留下"。
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import { Journal } from '../src/shared/journal.js'
import { TemporalTree } from '../src/host/memory/timetree.js'
import type { Scope } from '../src/shared/scope.js'
import type { EmotionAttribution, EmotionLabel } from '../src/shared/types.js'
import { openTestDb, tempRoot } from './helpers/db.js'

const NOW = 1_700_000_000_000
const scope: Scope = { workspaceId: 'ws_main', agentId: 'agent_fox', deviceId: 'devA' }
const GATE = 0.6

async function harness(t: import('node:test').TestContext) {
  const db = await openTestDb(t)
  if (!db) return undefined
  const root = await tempRoot(t)
  const journal = new Journal({ root, deviceId: 'devA', clock: () => NOW })
  await journal.open()
  const tree = new TemporalTree(db, journal, { clock: () => NOW, emotionConfidenceGate: GATE })
  return { db, root, journal, tree }
}

const valid: EmotionAttribution = {
  subject: 'YG',
  trigger: '依赖装不上卡了两小时',
  label: 'anxiety',
  intensity: 0.8,
  confidence: 0.9,
}

test('合格的情感归因：原样入库，并进入 journal', async (t) => {
  const h = await harness(t)
  if (!h) return

  const opened = await h.tree.openVersion({
    scope,
    kind: 'episode',
    subjectKey: 'incident:2026-11-16/dependency-install',
    text: '依赖安装卡住时 YG 明显焦虑，后来改成 tarball 直链解决',
    validFrom: NOW,
    emotion: valid,
    author: 'agent',
  })
  await h.journal.flush()

  assert.equal(opened.version.emo_subject, 'YG')
  assert.equal(opened.version.emo_trigger, '依赖装不上卡了两小时')
  assert.equal(opened.version.emo_label, 'anxiety')
  assert.equal(opened.version.emo_intensity, 0.8)
  assert.equal(opened.version.emo_confidence, 0.9)

  const ops = await h.journal.readMerged()
  const open = ops.find((record) => record.op === 'version.open')
  assert.ok(open, '必须有 version.open 记录')
  const emotion = open.emotion as EmotionAttribution
  assert.equal(emotion.label, 'anxiety')
})

test('低置信度（< 闸门 0.6）：整块丢弃，正文照常写入', async (t) => {
  const h = await harness(t)
  if (!h) return

  const opened = await h.tree.openVersion({
    scope,
    kind: 'episode',
    subjectKey: 'incident:low-confidence',
    text: 'LLM 猜了一个不太确定的情绪',
    validFrom: NOW,
    emotion: { ...valid, confidence: 0.59 },
    author: 'agent',
  })

  assert.equal(opened.version.text.length > 0, true, '正文不能因为情感不合格而被丢')
  assert.equal(opened.version.emo_label, null)
  assert.equal(opened.version.emo_subject, null)
  assert.equal(opened.version.emo_confidence, null)
})

test('非法 label：即使置信度很高也必须丢弃', async (t) => {
  const h = await harness(t)
  if (!h) return

  const opened = await h.tree.openVersion({
    scope,
    kind: 'episode',
    subjectKey: 'incident:illegal-label',
    text: 'LLM 幻觉出了一个不存在的情绪标签',
    validFrom: NOW,
    emotion: { ...valid, label: 'rage' as unknown as EmotionLabel, confidence: 0.99 },
    author: 'agent',
  })

  assert.equal(opened.version.emo_label, null, '枚举外的 label 一律不写库')
})

test('字段缺失（subject / trigger 为空）：丢弃整块情感', async (t) => {
  const h = await harness(t)
  if (!h) return

  const noSubject = await h.tree.openVersion({
    scope,
    kind: 'episode',
    subjectKey: 'incident:no-subject',
    text: '只有情绪没有主语',
    validFrom: NOW,
    emotion: { ...valid, subject: '   ' },
    author: 'agent',
  })
  assert.equal(noSubject.version.emo_label, null)

  const noTrigger = await h.tree.openVersion({
    scope,
    kind: 'episode',
    subjectKey: 'incident:no-trigger',
    text: '只有情绪没有诱因',
    validFrom: NOW + 1,
    emotion: { ...valid, trigger: '' },
    author: 'agent',
  })
  assert.equal(noTrigger.version.emo_label, null)
})

test('强度会钳制到 0..1：越界数值不能污染统计', async (t) => {
  const h = await harness(t)
  if (!h) return

  const opened = await h.tree.openVersion({
    scope,
    kind: 'episode',
    subjectKey: 'incident:clamp',
    text: '情绪强度被 LLM 写成 3',
    validFrom: NOW,
    emotion: { ...valid, intensity: 3 },
    author: 'agent',
  })
  assert.equal(opened.version.emo_intensity, 1)
})

test('不记录情感时不写空字段（null 就是 null，便于 UI 区分"没记"与"记了中性"）', async (t) => {
  const h = await harness(t)
  if (!h) return

  const opened = await h.tree.openVersion({
    scope,
    kind: 'fact',
    subjectKey: 'project:plain-fact',
    text: '这条是纯事实，不需要情绪标签',
    validFrom: NOW,
    emotion: null,
  })
  assert.equal(opened.version.emo_label, null)
  assert.equal(opened.version.emo_intensity, null)
})
