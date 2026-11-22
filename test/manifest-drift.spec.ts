/**
 * 清单与提交漂移：capture 扫的是工作区，`git add -A` 只收「仍存在且未被忽略」的文件。
 * ---------------------------------------------------------------------------
 * 真机事故（v0.5.8，设备 QS-DT 首次快照）：清单里列了
 * `journal/devices/QS-DT/2026-11-22.jsonl`，但那个提交里没有这个文件，于是之后每次
 * 启动都判 `snapshot-file-missing`，整机降级只读——用户什么都写不进去。
 *
 * 两条防线：
 *   ① 写端：commit 前以 git 索引为准收敛清单，保证「清单里列的 = 提交里有的」。
 *   ② 读端：遇到历史坏清单（清单多列、提交里没有）时，只要工作区副本哈希对得上就
 *      放行并告警，不再把整机拖进 degraded；真篡改（内容被换）仍然降级。
 */

import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { mkdir, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import test from 'node:test'
import { promisify } from 'node:util'

import { Journal } from '../src/shared/journal.js'
import { RestoreBarrier } from '../src/host/snapshot/barrier.js'
import { SnapshotEngine } from '../src/host/snapshot/engine.js'
import { ExecGitRunner } from '../src/host/snapshot/git.js'
import { RestoreEngine } from '../src/host/snapshot/restore.js'
import { openTestDb, tempRoot } from './helpers/db.js'

const execFileAsync = promisify(execFile)
const NOW = Date.UTC(2026, 0, 15, 3, 0, 0)
const DEVICE = 'devDrift'
const JOURNAL_PATH = `journal/devices/${DEVICE}/2026-01-15.jsonl`

async function git(cwd: string, args: readonly string[]): Promise<string> {
  const { stdout } = await execFileAsync('git', [...args], {
    cwd,
    windowsHide: true,
    env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
  })
  return stdout.trim()
}

/** 造一份最小的数据根：一个 journal 文件 + 一条快照。 */
async function makeEngine(t: Parameters<typeof tempRoot>[0]) {
  const root = await tempRoot(t, 'drift-')
  await mkdir(join(root, 'journal', 'devices', DEVICE), { recursive: true })
  await writeFile(join(root, JOURNAL_PATH), '{"op":"entity.upsert","seq":1}\n', 'utf8')
  const warnings: string[] = []
  const engine = new SnapshotEngine({
    root,
    deviceId: DEVICE,
    git: new ExecGitRunner({ cwd: root }),
    clock: () => NOW,
    sleep: async () => {},
    collectState: () => ({ agents: [] }),
    onWarn: (message) => warnings.push(message),
  })
  return { root, engine, warnings }
}

test('写端：capture 之后消失的文件不会留在清单里（提交与清单一致）', async (t) => {
  const { root, engine, warnings } = await makeEngine(t)
  const manifest = await engine.capture('manual')
  assert.ok(
    manifest.files.some((file) => file.path === JOURNAL_PATH),
    'capture 应该扫到这个 journal 文件',
  )

  // 模拟真机现场：capture 与 commit 之间这个文件没了（journal 轮转 / 被删 / 换机拷贝）。
  await rm(join(root, JOURNAL_PATH))

  const committed = await engine.commit(manifest)
  assert.ok(
    !committed.manifest.files.some((file) => file.path === JOURNAL_PATH),
    '清单必须被收敛，不能留下提交里不存在的条目',
  )
  assert.ok(
    warnings.some((message) => message.includes('已从清单剔除')),
    `应当告警说明剔除了文件，实际告警：${JSON.stringify(warnings)}`,
  )

  // 提交里确实没有它——这才是「一致」的定义。
  const tree = await git(root, ['ls-tree', '-r', '--name-only', `snap/${committed.manifest.snapshotId}`])
  assert.ok(!tree.split('\n').includes(JOURNAL_PATH), '提交里不应该有这个文件')
  // 清单文件本身必须进提交，否则下次启动读不到。
  assert.ok(
    tree.includes(`snapshots/${committed.manifest.snapshotId}/manifest.json`),
    'manifest.json 必须在提交里',
  )
})

test('读端：历史坏清单（清单多列、提交里没有）不再整机降级', async (t) => {
  const { root, engine, warnings: engineWarnings } = await makeEngine(t)
  const snapshot = await engine.snapshot('manual')
  assert.equal(engineWarnings.length, 0, '正常快照不该有告警')

  // 人为制造 v0.5.8 的历史坏数据：从快照提交里摘掉 journal 文件，工作区副本保留。
  await git(root, ['rm', '--cached', '--', JOURNAL_PATH])
  await git(root, [
    '-c',
    'user.name=drift',
    '-c',
    'user.email=drift@localhost',
    'commit',
    '--amend',
    '--no-edit',
  ])
  await git(root, ['tag', '-f', `snap/${snapshot.manifest.snapshotId}`, 'HEAD'])

  const db = await openTestDb(t)
  if (!db) return
  const barrier = new RestoreBarrier()
  const restoreWarnings: string[] = []
  const restore = new RestoreEngine({
    root,
    db,
    journal: new Journal({ root, deviceId: DEVICE }),
    barrier,
    git: new ExecGitRunner({ cwd: root }),
    onWarn: (message) => restoreWarnings.push(message),
  })

  const outcome = await restore.restoreOnBoot()
  assert.equal(
    outcome.status,
    'ready',
    `清单多列一份工作区完好的文件时不该降级，实际 ${outcome.status} / ${outcome.code ?? ''}`,
  )
  assert.ok(
    restoreWarnings.some((message) => message.includes('清单多列了')),
    `应告警说明清单多列了文件，实际告警：${JSON.stringify(restoreWarnings)}`,
  )
})
