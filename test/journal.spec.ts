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

test('readMerged：Lamport lc 优先于墙钟，lc 相同按事件时间+设备名', async (t) => {
  const root = await tempRoot(t)

  const devA = new Journal({ root, deviceId: 'devA', durable: false, clock: () => DAY })
  const devB = new Journal({ root, deviceId: 'devB', durable: false, clock: () => DAY })
  await devA.open()
  await devB.open()

  // 故意让墙钟顺序与写入顺序相反：先写"晚"的，再写"早"的。
  // lc 记录写入（因果）顺序，不理会墙钟漂移。
  await devA.append({ op: 'version.open', versionId: 'a3', at: DAY + 300 }) // lc=1
  await devB.append({ op: 'version.open', versionId: 'b2', at: DAY + 200 }) // lc=1
  await devA.append({ op: 'version.open', versionId: 'a1', at: DAY + 100 }) // lc=2
  // 同一 lc 且同一时刻：devA 必须排在 devB 前（device 名字典序）。
  await devB.append({ op: 'version.open', versionId: 'b1', at: DAY + 100 }) // lc=2

  const merged = await devA.readMerged()
  // lc=1 的 b2/a3 排前，lc=2 的 a1/b1 排后；lc 相同时才按墙钟。
  assert.deepEqual(
    merged.map((record) => record.versionId),
    ['b2', 'a3', 'a1', 'b1'],
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

test('Lamport 墓碑：跨设备墙钟漂移时，墓碑仍先于其后写入的复活记录', async (t) => {
  const root = await tempRoot(t)

  // devA 墙钟正常，写墓碑（lc=1）。
  const devA = new Journal({ root, deviceId: 'devA', durable: false, clock: () => DAY + 1000 })
  await devA.open()
  await devA.append({ op: 'agent.purge', agentId: 'ghost', at: DAY + 1000 })
  await devA.flush()

  // devB 墙钟慢（早于墓碑 1000ms），但冷启动 open() 时对齐 devA 的 lc 水位，
  // 因此其后写入的"复活记录"lc 必然大于墓碑（lc=2），不会排到墓碑前。
  const devB = new Journal({ root, deviceId: 'devB', durable: false, clock: () => DAY })
  await devB.open()
  await devB.append({ op: 'version.open', versionId: 'revived', at: DAY })
  await devB.flush()

  const merged = await devA.readMerged()
  assert.deepEqual(
    merged.map((record) => record.op),
    ['agent.purge', 'version.open'],
    '墓碑必须排在复活记录前，否则已销毁的记忆会借尸还魂',
  )
})

test('写闸门：withGate 执行期间 append 挂起，释放后按顺序落盘', async (t) => {
  const root = await tempRoot(t)
  const journal = new Journal({ root, deviceId: 'devA', durable: false, clock: () => DAY + 1000 })
  await journal.open()
  await journal.append({ op: 'memory.open', entityId: 'seed' })
  await journal.flush()

  const order: string[] = []
  const gate = journal.withGate(async () => {
    order.push('gate:enter')
    // 闸门内发起 append，但不等待它：若闸门失效，它会在下面的窗口内落盘。
    void journal.append({ op: 'memory.open', entityId: 'blocked' }).then(() => {
      order.push('append:blocked')
    })
    // 给被阻塞的 append 一个落盘机会（快照 capture→commit 的原子窗口）。
    await new Promise((resolve) => setTimeout(resolve, 25))
    order.push('gate:exit')
  })

  await gate
  order.push('gate:released')
  await journal.flush()

  // 核心断言：被闸门挡住的 append 必须排在闸门退出之后才落盘。
  assert.ok(
    order.indexOf('append:blocked') > order.indexOf('gate:exit'),
    `闸门失效：append 在闸门内落盘了，实际顺序 ${order.join(' → ')}`,
  )
  const merged = await journal.readMerged()
  assert.ok(merged.some((r) => r.entityId === 'blocked'), '闸门释放后，被阻塞的记录应已落盘')
})
