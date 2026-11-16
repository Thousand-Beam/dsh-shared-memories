/**
 * 灵魂测试：设备 A 停机 → 设备 B 冷启动。
 * ---------------------------------------------------------------------------
 * 这个文件不做任何 mock：真的建一个裸仓库当远端，真的 `git push`，真的让第二个
 * 进程内的引擎从零 `git init` + `fetch` + 校验 sha256 + 重放 journal。
 *
 * 为什么必须这样测：这套插件的全部价值就是"换台机器，一切照旧"。用假的 git 去测，
 * 测的是"我以为 git 会这样"，而不是 git 真会这样。四个断言对应四件真会出事的事：
 *
 *   ① 恢复前的屏障必须是 `cold`（不然写入会飘进半恢复的库）
 *   ② 冷启动必须走到 `ready`（pull → 验签 → 重放 → 完整性检查）
 *   ③ 设备 B 的 ScopedQuery 必须能查出设备 A 写的记忆（数据真的过去了）
 *   ④ 快照被篡改必须降级成只读 + `snapshot-corrupt`（宁可停摆，不可脏写）
 *
 * 多智能体也在断言里：两个 Agent 的人格要能一起漫游过去。
 */

import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import test, { type TestContext } from 'node:test'
import { promisify } from 'node:util'

import { Journal } from '../src/shared/journal.js'
import type { Scope } from '../src/shared/scope.js'
import { ScopedQuery } from '../src/host/memory/scoped-query.js'
import { TemporalTree } from '../src/host/memory/timetree.js'
import { RestoreBarrier } from '../src/host/snapshot/barrier.js'
import { SnapshotEngine } from '../src/host/snapshot/engine.js'
import { ExecGitRunner } from '../src/host/snapshot/git.js'
import type { SnapshotManifest } from '../src/host/snapshot/manifest.js'
import { RestoreEngine } from '../src/host/snapshot/restore.js'
import { openTestDb, tempRoot } from './helpers/db.js'

/** 固定时钟：快照 id、valid_from、recency 都基于它，测试才能逐字节比对。 */
const NOW = Date.UTC(2026, 0, 15, 3, 0, 0)
const WORKSPACE = 'ws-e2e-roaming'
const DEVICE_A = 'devA'
const DEVICE_B = 'devB'

const execFileAsync = promisify(execFile)

async function git(cwd: string, args: readonly string[]): Promise<string> {
  const { stdout } = await execFileAsync('git', [...args], { cwd, windowsHide: true })
  return stdout.trim()
}

/** 建一个裸仓库当"云端"：它没有工作区，只能被 push/pull，最接近真远端。 */
async function makeBareRemote(t: TestContext): Promise<string> {
  const parent = await tempRoot(t, 'bare-')
  const bare = join(parent, 'origin.git')
  await git(parent, ['init', '--bare', '--initial-branch=main', bare])
  return bare
}

interface DeviceA {
  readonly root: string
  readonly engine: SnapshotEngine
  readonly db: NonNullable<Awaited<ReturnType<typeof openTestDb>>>
  readonly journal: Journal
  readonly tree: TemporalTree
}

/** 设备 A：本地仓库 + 库 + 日志 + 两个 Agent 的记忆。 */
async function bootDeviceA(t: TestContext, bare: string): Promise<DeviceA | undefined> {
  const root = await tempRoot(t, 'device-a-')
  await git(root, ['init', '-b', 'main'])
  await git(root, ['config', 'user.email', 'device-a@example.test'])
  await git(root, ['config', 'user.name', 'Device A'])

  const db = await openTestDb(t)
  if (!db) return undefined

  const journal = new Journal({ root, deviceId: DEVICE_A })
  await journal.open()
  const tree = new TemporalTree(db, journal, { clock: () => NOW })

  const lead: Scope = { workspaceId: WORKSPACE, agentId: 'lead', deviceId: DEVICE_A }
  const coder: Scope = { workspaceId: WORKSPACE, agentId: 'coder', deviceId: DEVICE_A }

  await tree.openVersion({
    scope: lead,
    kind: 'fact',
    subjectKey: 'python.test-runner',
    text: 'Python 项目一律用 pytest 跑测试，别用 unittest',
    author: 'user',
    validFrom: NOW - 180_000,
  })
  await tree.openVersion({
    scope: lead,
    kind: 'preference',
    subjectKey: 'ui.copy.language',
    text: '控制台文案统一用中文，不夹英文缩写',
    author: 'user',
    validFrom: NOW - 120_000,
  })
  await tree.openVersion({
    scope: coder,
    kind: 'decision',
    subjectKey: 'prisma.migration-order',
    text: '迁移文件按时间戳命名，禁止手改顺序',
    author: 'user',
    validFrom: NOW - 60_000,
  })
  await journal.flush()

  const engine = new SnapshotEngine({
    root,
    deviceId: DEVICE_A,
    git: new ExecGitRunner({ cwd: root }),
    remote: bare,
    branch: 'main',
    clock: () => NOW,
    // 多智能体：两个 Agent 的人格与会话指针都要进快照。
    collectState: () => ({
      agents: [
        {
          agentId: 'lead',
          workspaceIds: [WORKSPACE],
          persona: { name: '大肥鱼', age: 11, traits: { curiosity: 0.82 }, baselineHash: 'base-v1' },
          sessions: ['sess-lead-1'],
        },
        {
          agentId: 'coder',
          workspaceIds: [WORKSPACE],
          persona: { name: '小狐狸', age: 9, traits: { rigor: 0.9 }, baselineHash: 'base-v1' },
          sessions: ['sess-coder-1'],
        },
      ],
    }),
  })

  return { root, engine, db, journal, tree }
}

test('设备 A 停机 → 设备 B 冷启动：快照、拉取、重放、跨设备可检索', async (t) => {
  const bare = await makeBareRemote(t)
  const a = await bootDeviceA(t, bare)
  if (!a) return

  // ── 设备 A 关机：抓快照 + 提交 + 推到"云端" ─────────────────────────────
  const snapshot = await a.engine.snapshot('shutdown')
  assert.equal(snapshot.pushed, true, '关机快照必须真的推上去')
  assert.deepEqual(snapshot.manifest.agentIds, ['coder', 'lead'], '两个 Agent 都要进 manifest')
  assert.ok(snapshot.manifest.files.length > 0, '快照里必须有文件')

  // ── 设备 B：全新空目录，什么都没有 ───────────────────────────────────────
  const rootB = await tempRoot(t, 'device-b-')
  const dbB = await openTestDb(t)
  if (!dbB) return

  const journalB = new Journal({ root: rootB, deviceId: DEVICE_B })
  const barrierB = new RestoreBarrier()

  // 断言 ①：恢复之前是 cold，且不接受写入。
  assert.equal(barrierB.phase, 'cold')
  assert.equal(barrierB.acceptsWrites, false)

  const restoreB = new RestoreEngine({
    root: rootB,
    db: dbB,
    journal: journalB,
    barrier: barrierB,
    git: new ExecGitRunner({ cwd: rootB }),
    remote: bare,
    branch: 'main',
  })

  const outcome = await restoreB.restoreOnBoot()

  // 断言 ②：真的 ready，而不是"降级了但假装成功"。
  assert.equal(outcome.status, 'ready', `冷启动应 ready，实际 ${outcome.status} / ${outcome.code ?? ''}`)
  assert.equal(barrierB.phase, 'ready')
  assert.equal(barrierB.acceptsWrites, true)
  assert.ok(outcome.snapshotId, '恢复结果应带上快照 id')

  // 断言 ③：设备 A 的记忆在设备 B 能被 ScopedQuery 查出来。
  const scopeB: Scope = { workspaceId: WORKSPACE, agentId: 'lead', deviceId: DEVICE_B }
  const queryB = new ScopedQuery(dbB, scopeB, { clock: () => NOW })
  const hits = queryB.search({ text: 'pytest 跑测试', limit: 5 })
  assert.ok(hits.length >= 1, '跨设备检索必须命中')
  assert.ok(hits[0]?.versionId, '命中的是真实版本而不是占位对象')

  const texts = dbB.all<{ text: string }>('SELECT text FROM memory_version WHERE valid_until IS NULL')
  assert.ok(
    texts.some((row) => row.text.includes('pytest')),
    '设备 A 写的正文必须原样出现在设备 B',
  )

  // 多智能体人格也漫游过来了：UI 下拉框才不会是空的。
  const personas = dbB.all<{ agent_id: string }>('SELECT agent_id FROM persona_state ORDER BY agent_id')
  assert.deepEqual(personas.map((row) => row.agent_id), ['coder', 'lead'])
})

test('快照被篡改 → 设备 B 进入 degraded 只读，错误码 snapshot-corrupt', async (t) => {
  const bare = await makeBareRemote(t)
  const a = await bootDeviceA(t, bare)
  if (!a) return
  const snapshot = await a.engine.snapshot('shutdown')

  // 先让设备 C 正常恢复一次，拿到真实的仓库内容。
  const rootC = await tempRoot(t, 'device-c-')
  const dbC = await openTestDb(t)
  if (!dbC) return

  const first = new RestoreEngine({
    root: rootC,
    db: dbC,
    journal: new Journal({ root: rootC, deviceId: 'devC' }),
    barrier: new RestoreBarrier(),
    git: new ExecGitRunner({ cwd: rootC }),
    remote: bare,
    branch: 'main',
  })
  const healthy = await first.restoreOnBoot()
  assert.equal(healthy.status, 'ready')

  // ── 手动篡改一个被快照覆盖的文件（模拟"云端仓库被人动过"）───────────────
  const manifestPath = join(rootC, 'snapshots', snapshot.manifest.snapshotId, 'manifest.json')
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8')) as SnapshotManifest
  const victim = manifest.files.find((file) => file.path.startsWith('journal/')) ?? manifest.files[0]
  assert.ok(victim, '快照清单里必须能找到可篡改的文件')
  const original = await readFile(join(rootC, victim.path), 'utf8')
  await writeFile(join(rootC, victim.path), `${original}\n{"tampered":true}\n`, 'utf8')

  // ── 再启动一次（纯本地，不 pull，避免远端把篡改盖回去）────────────────────
  const barrier2 = new RestoreBarrier()
  const second = new RestoreEngine({
    root: rootC,
    db: dbC,
    journal: new Journal({ root: rootC, deviceId: 'devC' }),
    barrier: barrier2,
    git: new ExecGitRunner({ cwd: rootC }),
    remote: '',
    branch: 'main',
  })

  const outcome = await second.restoreOnBoot()

  // 断言 ④：降级而不是崩溃，也不是"带病 ready"。
  assert.equal(outcome.status, 'degraded')
  assert.equal(outcome.code, 'snapshot-corrupt')
  assert.equal(barrier2.phase, 'degraded')
  assert.equal(barrier2.acceptsWrites, false, '降级后必须拒绝写入')
  assert.equal(barrier2.readOnly, true)
})
