/**
 * Journal 单测：并发 append 不交错半行、损坏 JSON 行跳过容错、
 * readMerged 跨设备多时间线排序。
 * ---------------------------------------------------------------------------
 * journal 是**唯一的真相源**，它出问题等于记忆全丢。所以这里的断言很偏执：
 * 不只断言"能读回来"，还要断言"文件里的字节是完整的 N 行"。
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import { join } from 'node:path'
import { appendFile } from 'node:fs/promises'
import { Journal } from '../src/shared/journal.js'
import { readText, tempRoot } from './helpers/db.js'

const DAY = 1_700_000_000_000
const dayFile = (root: string, device: string, at: number): string =>
  join(root, 'journal', 'devices', device, `${new Date(at).toISOString().slice(0, 10)}.jsonl`)

test('并发 append：不产生交错半行，seq 连续无空洞', async (t) => {
  const root = await tempRoot(t)
  const journal = new Journal({ root, deviceId: 'devA', durable: false, clock: () => DAY })
  await journal.open()

  const total = 40
  const records = await Promise.all(
    Array.from({ length: total }, (_, index) =>
      journal.append({ op: 'memory.note', payload: `第 ${index} 条`, at: DAY + index }),
    ),
  )

  assert.equal(records.length, total)
  const seqs = records.map((record) => record.seq).sort((a, b) => a - b)
  assert.deepEqual(
    seqs,
    Array.from({ length: total }, (_, index) => index + 1),
    'seq 必须在 1..N 连续，否则回放会漏',
  )

  const raw = await readText(dayFile(root, 'devA', DAY))
  const lines = raw.split('\n').filter((line) => line.length > 0)
  assert.equal(lines.length, total, `文件行数应为 ${total}`)
  for (const line of lines) {
    // 任何一行解析失败 = 并发写把两行粘在一起了。
    const parsed = JSON.parse(line) as { v: number; seq: number; device: string; op: string }
    assert.equal(parsed.v, 1)
    assert.equal(parsed.device, 'devA')
    assert.equal(typeof parsed.seq, 'number')
  }
})

test('损坏行容错：跳过坏行并告警，好行照常读出', async (t) => {
  const root = await tempRoot(t)
  const warnings: string[] = []
  const journal = new Journal({
    root,
    deviceId: 'devB',
    durable: false,
    clock: () => DAY,
    onWarn: (message) => warnings.push(message),
  })
  await journal.open()

  await journal.append({ op: 'entity.upsert', entityId: 'ent_1', at: DAY })
  // 模拟"某次崩溃写了半行"或"人工编辑写坏了"。
  await appendFile(dayFile(root, 'devB', DAY), '{"v":1,"seq":2,"op":"version.op\n', 'utf8')
  await journal.append({ op: 'version.open', versionId: 'ver_1', at: DAY + 1 })

  const seen: string[] = []
  for await (const record of journal.readDevice('devB')) seen.push(record.op)

  assert.deepEqual(seen, ['entity.upsert', 'version.open'])
  assert.ok(warnings.length >= 1, '坏行必须告警，不能静默吞掉')
})

test('readMerged：跨设备按事件时间排序，同一时刻按设备名稳定次序', async (t) => {
  const root = await tempRoot(t)

  const devA = new Journal({ root, deviceId: 'devA', durable: false, clock: () => DAY })
  const devB = new Journal({ root, deviceId: 'devB', durable: false, clock: () => DAY })
  await devA.open()
  await devB.open()

  // 故意打乱写入顺序：先写晚的，再写早的。
  await devA.append({ op: 'version.open', versionId: 'a3', at: DAY + 300 })
  await devB.append({ op: 'version.open', versionId: 'b2', at: DAY + 200 })
  await devA.append({ op: 'version.open', versionId: 'a1', at: DAY + 100 })
  // 同一时刻的不同设备：devA 必须排在 devB 前（device 名字典序）。
  await devB.append({ op: 'version.open', versionId: 'b1', at: DAY + 100 })

  const merged = await devA.readMerged()
  assert.deepEqual(
    merged.map((record) => record.versionId),
    ['a1', 'b1', 'b2', 'a3'],
  )

  const devices = await devA.listDevices()
  assert.deepEqual(devices, ['devA', 'devB'])

  const recent = await devA.readMerged({ sinceAt: DAY + 150 })
  assert.deepEqual(
    recent.map((record) => record.versionId),
    ['b2', 'a3'],
  )
})

test('open() 从磁盘恢复 seq：重启后继续追加不会与历史撞号', async (t) => {
  const root = await tempRoot(t)
  const first = new Journal({ root, deviceId: 'devC', durable: false, clock: () => DAY })
  await first.open()
  await first.append({ op: 'entity.upsert', entityId: 'ent_1', at: DAY })
  await first.append({ op: 'entity.upsert', entityId: 'ent_2', at: DAY })
  await first.flush()

  const restarted = new Journal({ root, deviceId: 'devC', durable: false, clock: () => DAY })
  await restarted.open()
  assert.equal(restarted.lastSeq, 2, '重启后必须知道已用到的最大 seq')

  const next = await restarted.append({ op: 'entity.upsert', entityId: 'ent_3', at: DAY })
  assert.equal(next.seq, 3)
})
