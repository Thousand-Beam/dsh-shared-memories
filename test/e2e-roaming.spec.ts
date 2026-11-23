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
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import test, { type TestContext } from 'node:test'
import { promisify } from 'node:util'

import { Journal } from '../src/shared/journal.js'
import type { Scope } from '../src/shared/scope.js'
import { ScopedQuery } from '../src/host/memory/scoped-query.js'
import { TemporalTree } from '../src/host/memory/timetree.js'
import { RestoreBarrier } from '../src/host/snapshot/barrier.js'
import { SnapshotEngine, SnapshotError } from '../src/host/snapshot/engine.js'
import { ExecGitRunner } from '../src/host/snapshot/git.js'
import { snapshotIdOf, type SnapshotManifest } from '../src/host/snapshot/manifest.js'
import { RestoreEngine } from '../src/host/snapshot/restore.js'
import { purgeAgent } from '../src/host/memory/purge.js'
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
    // 测试里不要真等退避：git.ts 的注释就要求"测试里替换成零延迟"。
    // 真等待会让 push 首次失败时把测试时间拖到秒级，CI 上更会因事件循环短暂
    // 变空被 node:test 判为挂起而取消。
    sleep: async () => {},
    // D-03：rollback 追加截断墓碑需要 journal 引用。
    journal,
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
  assert.equal(
    outcome.status,
    'ready',
    `冷启动应 ready，实际 ${outcome.status} / ${outcome.code ?? ''} / ${outcome.error instanceof Error ? outcome.error.message : ''}`,
  )
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

  // ── 篡改快照提交本身（模拟"云端仓库被人动过"：改内容 + 重写快照 tag）───────
  // 注意：校验基准是 git 对象（tag snap/<id> 指向的提交），不是工作区文件——
  // 工作区在快照之后继续写是正常前进，不能因此降级（否则每次重启都误判）。
  const manifestPath = join(rootC, 'snapshots', snapshot.manifest.snapshotId, 'manifest.json')
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8')) as SnapshotManifest
  const victim = manifest.files.find((file) => file.path.startsWith('journal/')) ?? manifest.files[0]
  assert.ok(victim, '快照清单里必须能找到可篡改的文件')
  const original = await readFile(join(rootC, victim.path), 'utf8')
  await writeFile(join(rootC, victim.path), `${original}\n{"tampered":true}\n`, 'utf8')
  await git(rootC, ['config', 'user.email', 'tamper@example.test'])
  await git(rootC, ['config', 'user.name', 'Tamper'])
  await git(rootC, ['add', '-A'])
  await git(rootC, ['commit', '--amend', '--no-edit'])
  // 投毒者会连快照书签一起重写；否则 restore 读到的还是原始提交，篡改就藏在工作区。
  await git(rootC, ['tag', '-f', `snap/${snapshot.manifest.snapshotId}`])

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

test('repo.path 指向陌生 git 仓库 → 拒绝快照（repo-hijack）', async (t) => {
  const dsmRemote = await makeBareRemote(t) // 配置的同步远端
  const projectRemote = await makeBareRemote(t) // "项目"自己的远端（陌生）

  // root 是一个已存在的 git 仓库，origin 指向项目远程——这是别人的仓库。
  const root = await tempRoot(t, 'hijack-snap-')
  await git(root, ['init', '-b', 'main'])
  await git(root, ['remote', 'add', 'origin', projectRemote])
  await writeFile(join(root, 'package.json'), JSON.stringify({ name: 'someone-elses-project' }))

  const engine = new SnapshotEngine({
    root,
    deviceId: 'devA',
    git: new ExecGitRunner({ cwd: root }),
    remote: dsmRemote,
    branch: 'main',
    clock: () => NOW,
    sleep: async () => {},
    collectState: () => ({ agents: [] }),
  })

  await assert.rejects(
    () => engine.snapshot('shutdown'),
    (error: unknown) => error instanceof SnapshotError && error.code === 'repo-hijack',
    '快照必须拒绝在别人的仓库里 git add -A + push',
  )
})

test('restore 时 repo.path 指向陌生 git 仓库 → 降级只读（repo-hijack）', async (t) => {
  const dsmRemote = await makeBareRemote(t)
  const projectRemote = await makeBareRemote(t)

  const root = await tempRoot(t, 'hijack-restore-')
  await git(root, ['init', '-b', 'main'])
  await git(root, ['remote', 'add', 'origin', projectRemote])

  const db = await openTestDb(t)
  if (!db) return
  const restore = new RestoreEngine({
    root,
    db,
    journal: new Journal({ root, deviceId: 'devB' }),
    barrier: new RestoreBarrier(),
    git: new ExecGitRunner({ cwd: root }),
    remote: dsmRemote,
    branch: 'main',
  })

  const outcome = await restore.restoreOnBoot()
  assert.equal(outcome.status, 'degraded')
  assert.equal(outcome.code, 'repo-hijack', '拒绝把记忆拉进别人的仓库，宁可只读降级')
})

test('repo.path 嵌套在别的 Git 仓库的子目录 → 拒绝快照（toplevel 检测）', async (t) => {
  const dsmRemote = await makeBareRemote(t)

  // 外层是"别人的项目仓库"（origin 指向项目远程），里面有敏感文件。
  const outer = await tempRoot(t, 'outer-project-')
  await git(outer, ['init', '-b', 'main'])
  const projectRemote = await makeBareRemote(t)
  await git(outer, ['remote', 'add', 'origin', projectRemote])
  await writeFile(join(outer, '.env'), 'SECRET_TOKEN=abc123\n')

  // repo.path 是外层仓库的子目录，本身不是独立 git 仓库。
  // `git rev-parse --git-dir` 会返回父目录的 .git，probe 成功，走 else 分支。
  const nested = join(outer, 'shared-memories')
  await mkdir(nested, { recursive: true })

  const engine = new SnapshotEngine({
    root: nested,
    deviceId: 'devA',
    git: new ExecGitRunner({ cwd: nested }),
    remote: dsmRemote,
    branch: 'main',
    clock: () => NOW,
    sleep: async () => {},
    collectState: () => ({ agents: [] }),
  })

  await assert.rejects(
    () => engine.snapshot('shutdown'),
    (error: unknown) => error instanceof SnapshotError && error.code === 'repo-hijack',
    '快照必须拒绝在别人仓库的子目录里 git add -A（会把 .env 一并提交推送）',
  )
})

test('rollback 后删除派生库 memory.db，强制下次冷启动全量重放', async (t) => {
  const bare = await makeBareRemote(t)
  const a = await bootDeviceA(t, bare)
  if (!a) return

  // 在数据根放一个 memory.db 派生文件（openTestDb 用的是 :memory: 库，不落盘）。
  // rollback 的 `git checkout tag -- .` 不会回退它（gitignore），必须显式删掉。
  await writeFile(join(a.root, 'memory.db'), 'fake-derived-db-content')

  const snap = await a.engine.snapshot('shutdown')
  await a.engine.rollback(snap.manifest.snapshotId)

  const leftover = await readFile(join(a.root, 'memory.db'))
    .then(() => true)
    .catch(() => false)
  assert.equal(leftover, false, 'rollback 后 memory.db 必须被删除，否则旧库与旧 journal 不一致会锁死只读')
})

test('D-03：rollback 后冷启动重放回到回退点，晚于快照的记忆不复现', async (t) => {
  const bare = await makeBareRemote(t)
  const a = await bootDeviceA(t, bare)
  if (!a) return

  // 快照 S1（含 lead/coder 的初始记忆）
  const snap = await a.engine.snapshot('shutdown')
  assert.equal(snap.pushed, true, '回退点的快照必须先推上去')

  // 快照之后写一条新记忆（模拟跨天 import：at 落在晚于 S1 的 UTC 日期，
  // journal 按日期分片会写进一个新的、S1 树里不存在的分片文件）。
  const lateAt = Date.UTC(2099, 0, 1, 0, 0, 0)
  const lateEntityId = 'ent-rollback-late'
  await a.journal.append({
    op: 'entity.upsert',
    at: lateAt,
    entityId: lateEntityId,
    workspaceId: WORKSPACE,
    agentId: 'lead',
    kind: 'fact',
    subjectKey: 'rollback.late-memory',
    canonical: '这条记忆晚于回退点，不该复活',
    salience: 0.5,
    trust: 0.6,
    status: 'active',
    contentHash: 'rollback-late-hash',
    deviceId: DEVICE_A,
  })
  await a.journal.append({
    op: 'version.open',
    at: lateAt,
    entityId: lateEntityId,
    workspaceId: WORKSPACE,
    agentId: 'lead',
    versionId: 'ver-rollback-late',
    seq: 1,
    validFrom: lateAt,
    validUntil: null,
    text: '这条记忆晚于回退点，不该复活',
    distillStatus: 'raw',
    author: 'user',
    deviceId: DEVICE_A,
  })
  await a.journal.flush()

  // rollback 到 S1
  await a.engine.rollback(snap.manifest.snapshotId)

  // 冷启动重放：新 db + 新 journal 实例，但同一 root（同仓库第二次启动场景）
  const db2 = await openTestDb(t)
  if (!db2) return
  const journal2 = new Journal({ root: a.root, deviceId: DEVICE_A })
  const barrier2 = new RestoreBarrier()
  const restore = new RestoreEngine({
    root: a.root,
    db: db2,
    journal: journal2,
    barrier: barrier2,
    git: new ExecGitRunner({ cwd: a.root }),
    remote: bare,
    branch: 'main',
  })
  const outcome = await restore.restoreOnBoot()
  assert.equal(
    outcome.status,
    'ready',
    `rollback 后冷启动应 ready，实际 ${outcome.status} / ${outcome.code ?? ''} / ${outcome.error instanceof Error ? outcome.error.message : ''}`,
  )

  // 断言：晚于快照的记忆不复现
  const texts = db2.all<{ text: string }>('SELECT text FROM memory_version WHERE valid_until IS NULL')
  assert.ok(
    !texts.some((row) => row.text.includes('晚于回退点')),
    `晚于回退点的记忆不应复活，实际版本：${texts.map((row) => row.text).join(' | ')}`,
  )
  // 回退点之前的记忆仍在（回退不是清空）
  assert.ok(
    texts.some((row) => row.text.includes('pytest')),
    '回退点之前的记忆应该保留',
  )
})

test('空远端（裸仓库无任何提交）→ 冷启动按首次播种处理，不降级', async (t) => {
  const bare = await makeBareRemote(t) // 空裸仓库，无 commit、无 ref。

  const root = await tempRoot(t, 'empty-remote-')
  await git(root, ['init', '-b', 'main'])

  const db = await openTestDb(t)
  if (!db) return

  const restore = new RestoreEngine({
    root,
    db,
    journal: new Journal({ root, deviceId: 'devB' }),
    barrier: new RestoreBarrier(),
    git: new ExecGitRunner({ cwd: root }),
    remote: bare,
    branch: 'main',
  })

  // 评价四 P0-2：空远端 fetch 报 "couldn't find remote ref main"，此前按 pull-failed
  // 降级只读 → 模式 B 首次启动永久死锁。修复后识别为空远端，按首次播种继续走 ready。
  const outcome = await restore.restoreOnBoot()
  assert.equal(outcome.status, 'ready', `空远端首启应 ready（首次播种），实际 ${outcome.status} / ${outcome.code ?? ''}`)
})

test('A 销毁 lead → push → B 冷启动：被销毁记忆与人格都不复活（跨设备销毁）', async (t) => {
  const bare = await makeBareRemote(t)

  const root = await tempRoot(t, 'device-a-purge-')
  await git(root, ['init', '-b', 'main'])
  await git(root, ['config', 'user.email', 'a@example.test'])
  await git(root, ['config', 'user.name', 'Device A'])

  const db = await openTestDb(t)
  if (!db) return
  const journal = new Journal({ root, deviceId: DEVICE_A })
  await journal.open()
  const tree = new TemporalTree(db, journal, { clock: () => NOW })

  // 写 lead 的"绝密记忆" + 登记两个 Agent 的人格行（模拟 agent/created 的 ensureAgentRow）。
  const lead: Scope = { workspaceId: WORKSPACE, agentId: 'lead', deviceId: DEVICE_A }
  await tree.openVersion({
    scope: lead,
    kind: 'fact',
    subjectKey: 'lead.secret',
    text: '绝密记忆：保险箱密码是 7355608',
    author: 'user',
    validFrom: NOW - 1000,
  })
  db.run('INSERT INTO persona_state (agent_id, workspace_id, name, updated_at) VALUES (?,?,?,?)', ['lead', WORKSPACE, '大肥鱼', NOW])
  db.run('INSERT INTO persona_state (agent_id, workspace_id, name, updated_at) VALUES (?,?,?,?)', ['coder', WORKSPACE, '小狐狸', NOW])
  await journal.flush()

  // collectState 读 db 的 persona_state（真实语义：purge 删掉行后，快照就不再带这个人格）。
  // 引擎的告警必须收集起来：push 失败在 snapshot() 里会被降级成 pushed:false，
  // 不冒泡就只剩"远端没数据"，断言信息看不出真正原因。
  const warnings: string[] = []
  const engine = new SnapshotEngine({
    root,
    deviceId: DEVICE_A,
    git: new ExecGitRunner({ cwd: root }),
    remote: bare,
    branch: 'main',
    clock: () => NOW,
    sleep: async () => {},
    onWarn: (message) => warnings.push(message),
    collectState: () => ({
      agents: db
        .all<{ agent_id: string; name: string }>('SELECT agent_id, name FROM persona_state WHERE workspace_id = ?', [WORKSPACE])
        .map((row) => ({ agentId: row.agent_id, workspaceIds: [WORKSPACE], persona: { name: row.name }, sessions: [] })),
    }),
  })

  // 第一次快照：lead + coder 完整漫游到远端。
  const firstSnapshot = await engine.snapshot('shutdown')
  assert.equal(firstSnapshot.pushed, true, `销毁场景的首次快照必须推上远端；${warnings.join(' | ')}`)

  // A 销毁 lead（写墓碑 + 删库 + 删 persona 文件）。
  const purge = await purgeAgent({ db, root, workspaceId: WORKSPACE, agentId: 'lead', sessionId: 'lead', clock: () => NOW })
  assert.equal(purge.tombstone, true, '墓碑必须落盘，否则销毁不生效')

  // 第二次快照：collectState 读 db，lead 已删 → 快照不再带 persona/lead.json。
  // 固定时钟下两次快照同秒，id 必须被去重（否则 tag 被 -f 改写、push 被远端拒）。
  const secondSnapshot = await engine.snapshot('shutdown')
  assert.equal(secondSnapshot.pushed, true, `销毁后的第二次快照必须推上远端；${warnings.join(' | ')}`)
  assert.notEqual(secondSnapshot.manifest.snapshotId, firstSnapshot.manifest.snapshotId, '同一秒内的两次快照必须拿到不同 snapshotId')

  // B 全新冷启动。
  const rootB = await tempRoot(t, 'device-b-purge-')
  const dbB = await openTestDb(t)
  if (!dbB) return
  const restoreB = new RestoreEngine({
    root: rootB,
    db: dbB,
    journal: new Journal({ root: rootB, deviceId: DEVICE_B }),
    barrier: new RestoreBarrier(),
    git: new ExecGitRunner({ cwd: rootB }),
    remote: bare,
    branch: 'main',
  })
  const outcome = await restoreB.restoreOnBoot()
  assert.equal(
    outcome.status,
    'ready',
    `销毁后 B 冷启动应 ready，实际 ${outcome.status} / ${outcome.code ?? ''} / ${outcome.error instanceof Error ? outcome.error.message : ''}`,
  )

  // 被销毁的 lead 记忆不复活。
  const leadMemories = dbB.all<{ text: string }>(
    'SELECT text FROM memory_version WHERE entity_id IN (SELECT entity_id FROM memory_entity WHERE workspace_id = ? AND agent_id = ?)',
    [WORKSPACE, 'lead'],
  )
  assert.equal(leadMemories.length, 0, '被销毁的 lead 记忆不得复活')

  // 被销毁的 lead 人格不复活。
  const leadPersona = dbB.all<{ agent_id: string }>('SELECT agent_id FROM persona_state WHERE workspace_id = ? AND agent_id = ?', [WORKSPACE, 'lead'])
  assert.equal(leadPersona.length, 0, '被销毁的 lead 人格不得复活')

  // coder 不受影响。
  const coderPersona = dbB.all<{ agent_id: string }>('SELECT agent_id FROM persona_state WHERE workspace_id = ? AND agent_id = ?', [WORKSPACE, 'coder'])
  assert.equal(coderPersona.length, 1, 'coder 人格不受 lead 销毁影响')
})

test('远端已有同名 snap tag（两台设备同一秒各拍一次）→ 分支照常推送，不算 push 失败', async (t) => {
  const bare = await makeBareRemote(t)
  const at = NOW
  // id 已掺 deviceId（见 engine.#uniqueSnapshotId），本引擎 deviceId=DEVICE_B='devB'，
  // 真实 tag 是 `snap/<at>-devB`；预置同名 tag 才能复现「远端已有同名 tag」的冲突前提。
  const clashTag = `snap/${snapshotIdOf(at)}-devB`

  // 模拟"另一台设备在同一秒先拍过一次"：远端已存在同名 tag，指向别的提交。
  // git 不允许改写远端同名 tag，把 tag 和分支塞进同一条 push 会让整条命令失败。
  const peer = await tempRoot(t, 'peer-device-')
  await git(peer, ['init', '-b', 'main'])
  await git(peer, ['config', 'user.email', 'peer@example.test'])
  await git(peer, ['config', 'user.name', 'Peer'])
  await writeFile(join(peer, 'peer.txt'), 'peer\n')
  await git(peer, ['add', '-A'])
  await git(peer, ['commit', '-m', 'peer snapshot'])
  await git(peer, ['tag', '-a', clashTag, '-m', 'peer tag'])
  await git(peer, ['remote', 'add', 'origin', bare])
  // 推到另一条分支：本测试只关心"同名 tag 已存在"，不要让 main 分叉混淆结论。
  await git(peer, ['push', 'origin', 'main:peer-main'])
  await git(peer, ['push', 'origin', `refs/tags/${clashTag}`])

  const root = await tempRoot(t, 'tag-clash-')
  const warnings: string[] = []
  const engine = new SnapshotEngine({
    root,
    deviceId: DEVICE_B,
    git: new ExecGitRunner({ cwd: root }),
    remote: bare,
    branch: 'main',
    clock: () => at,
    sleep: async () => {},
    onWarn: (message) => warnings.push(message),
    collectState: () => ({ agents: [] }),
  })

  const result = await engine.snapshot('shutdown')
  assert.equal(result.pushed, true, `tag 冲突不应让整次 push 失败；${warnings.join(' | ')}`)
  assert.match(warnings.join('\n'), /tag 推送被拒/, 'tag 被拒必须留下告警，不能静默')

  // 数据（分支）必须真的落到远端，否则"推成功"是假的。
  const remoteLog = await git(bare, ['log', '--format=%s', 'main'])
  assert.match(remoteLog, /snapshot\(shutdown\)/, '远端分支必须拿到本机提交')
})

test('跨设备同秒互推：两台设备同一秒各拍一次，id 掺 deviceId，两边都推上远端', async (t) => {
  const bare = await makeBareRemote(t)
  const at = NOW

  // 两台设备用同一个固定时钟（同一秒）各建一个仓库 + 引擎，collectState 完全相同，
  // 这样唯一的分歧来源就是「同秒 id 撞名」——正是 v0.4.1 宣称修复、却只修了本机的场景。
  async function boot(t2: TestContext, deviceId: string, name: string): Promise<SnapshotEngine | undefined> {
    const root = await tempRoot(t2, `same-sec-${name}-`)
    await git(root, ['init', '-b', 'main'])
    await git(root, ['config', 'user.email', `${name}@example.test`])
    await git(root, ['config', 'user.name', name])
    return new SnapshotEngine({
      root,
      deviceId,
      git: new ExecGitRunner({ cwd: root }),
      remote: bare,
      branch: 'main',
      clock: () => at,
      sleep: async () => {},
      collectState: () => ({ agents: [] }),
    })
  }

  const engineA = await boot(t, DEVICE_A, 'dev-a')
  const engineB = await boot(t, DEVICE_B, 'dev-b')
  if (!engineA || !engineB) return

  // 同一秒各拍一次。
  const snapA = await engineA.snapshot('shutdown')
  const snapB = await engineB.snapshot('shutdown')

  // 核心断言：id 掺 deviceId，两台设备同秒不再撞同一个 …Z（修复前会是同一个 id，
  // 同名 manifest.json → push 被拒 → pull --rebase add/add 冲突）。
  assert.equal(snapA.manifest.snapshotId, `${snapshotIdOf(at)}-devA`, 'A 的 id 应带 devA 后缀')
  assert.equal(snapB.manifest.snapshotId, `${snapshotIdOf(at)}-devB`, 'B 的 id 应带 devB 后缀')
  assert.notEqual(snapA.manifest.snapshotId, snapB.manifest.snapshotId, '同秒快照 id 必须去重')

  // 两台都推上远端（B 后推，会走 pull --rebase 追平 A 的提交，但同秒 id 已不同，
  // 不再 add/add 冲突，rebase 干净合并后 push 成功）。
  assert.equal(snapA.pushed, true, 'A 必须推上远端')
  assert.equal(snapB.pushed, true, 'B 必须推上远端（同秒 id 已去重，不应 rebase 卡死）')

  // 远端同时保留两台设备的快照 tag，不是互相覆盖。
  const remoteTags = await git(bare, ['tag', '--list', `snap/${snapshotIdOf(at)}-*`])
  assert.match(remoteTags, /snap\/[^-]+-devA/, '远端必须有 A 的 tag')
  assert.match(remoteTags, /snap\/[^-]+-devB/, '远端必须有 B 的 tag')
})

test('跨设备同逻辑状态、不同墙钟：状态文件确定性，不触发 diverged（P1-B）', async (t) => {
  const bare = await makeBareRemote(t)
  const at = NOW

  // 两台设备墙钟毫秒不同（模拟真实 NTP 偏差），但同一秒、同逻辑状态。
  // v0.4.1 的状态文件写 capturedAt 墙钟，这里就会 add/add 冲突；删掉后字节相同。
  async function boot(t2: TestContext, deviceId: string, name: string, wallOffsetMs: number): Promise<SnapshotEngine | undefined> {
    const root = await tempRoot(t2, `wall-${name}-`)
    await git(root, ['init', '-b', 'main'])
    await git(root, ['config', 'user.email', `${name}@example.test`])
    await git(root, ['config', 'user.name', name])
    return new SnapshotEngine({
      root,
      deviceId,
      git: new ExecGitRunner({ cwd: root }),
      remote: bare,
      branch: 'main',
      clock: () => at + wallOffsetMs,
      sleep: async () => {},
      collectState: () => ({
        agents: [
          { agentId: 'lead', workspaceIds: [WORKSPACE], sessions: ['sess-1'], persona: { name: '小狐', age: 20 } },
        ],
      }),
    })
  }

  const engineA = await boot(t, DEVICE_A, 'dev-a', 0)
  const engineB = await boot(t, DEVICE_B, 'dev-b', 500)
  if (!engineA || !engineB) return

  const snapA = await engineA.snapshot('shutdown')
  const snapB = await engineB.snapshot('shutdown')

  // 核心断言：两台墙钟毫秒不同（真实 NTP 场景），但状态文件（已删 capturedAt/device）
  // 逐字节相同，所以 B 后推 pull --rebase 不再 add/add 冲突，两台都 push 成功。
  assert.equal(snapA.pushed, true, 'A 必须推上远端')
  assert.equal(snapB.pushed, true, 'B 必须推上远端（墙钟毫秒差异不应制造假 add/add 冲突）')

  // 两个快照 tag 都在，不是互相覆盖、也没 diverged 停摆。
  const remoteTags = await git(bare, ['tag', '--list', `snap/${snapshotIdOf(at)}-*`])
  assert.match(remoteTags, /-devA/, '远端必须有 A 的 tag')
  assert.match(remoteTags, /-devB/, '远端必须有 B 的 tag')
})

test('真分叉（两台设备各改不同人格）→ diverged 且 pushBaseSnapshotId 指向共同祖先快照', async (t) => {
  const bare = await makeBareRemote(t)
  const at = NOW

  const mkEngine = async (
    deviceId: string,
    tag: string,
    name: string,
    existingRoot?: string,
  ): Promise<{ engine: SnapshotEngine; root: string; warnings: string[] }> => {
    const root = existingRoot ?? (await tempRoot(t, `diverge-${tag}-`))
    if (!existingRoot) await git(root, ['init', '-b', 'main'])
    await git(root, ['config', 'user.email', `${tag}@example.test`])
    await git(root, ['config', 'user.name', tag])
    const warnings: string[] = []
    const engine = new SnapshotEngine({
      root,
      deviceId,
      git: new ExecGitRunner({ cwd: root }),
      remote: bare,
      branch: 'main',
      clock: () => at,
      sleep: async () => {},
      onWarn: (message) => warnings.push(message),
      collectState: () => ({
        agents: [
          { agentId: 'lead', workspaceIds: [WORKSPACE], sessions: ['sess-1'], persona: { name, age: 20 } },
        ],
      }),
    })
    return { engine, root, warnings }
  }

  // A 连拍两次：远端从 A1 前进到 A2。第二拍必须换人格（大肥鱼→大鲨鱼）——
  // 若两次快照状态完全相同，A2 相对 A1 只多快照归档目录，B 的改动与 A2 没有
  // 共同文件冲突，rebase 会干净合并，push 成功，造不出真分叉（v0.5.9 发布时
  // CI 163/164 唯一失败用例就是栽在这里：assert pushed===false 实际为 true）。
  const a = await mkEngine(DEVICE_A, 'dev-a', '大肥鱼')
  const snapA1 = await a.engine.snapshot('shutdown')
  assert.equal(snapA1.pushed, true, `A1 必须推上远端；${a.warnings.join(' | ')}`)
  const a2 = await mkEngine(DEVICE_A, 'dev-a', '大鲨鱼', a.root)
  const snapA2 = await a2.engine.snapshot('shutdown')
  assert.equal(snapA2.pushed, true, `A2 必须推上远端；${a2.warnings.join(' | ')}`)
  assert.notEqual(snapA1.manifest.snapshotId, snapA2.manifest.snapshotId)

  // B 从远端 clone 后回到 A1 的位置，再改成人格「小狐狸」提交——
  // 此时远端已走到 A2，B1 与 A2 从 A1 处真正分叉（不是同秒 id 冲突）。
  const rootB = await tempRoot(t, 'diverge-dev-b-')
  await execFileAsync('git', ['clone', bare, rootB], { windowsHide: true })
  await git(rootB, ['reset', '--hard', snapA1.commit])
  const b = await mkEngine(DEVICE_B, 'dev-b', '小狐狸', rootB)

  const snapB = await b.engine.snapshot('shutdown')
  assert.equal(snapB.pushed, false, '真分叉必须诚实报未推送')
  assert.equal(snapB.pushReason, 'diverged', `应为 diverged；warnings=${b.warnings.join(' | ')}`)
  // 终审 P4 第 3 件：分叉时要告诉用户「最近一次共同祖先的快照 id」——
  // 这里共同祖先就是 A1（B 从 A1 的 commit 起步，远端已走到 A2）。
  assert.equal(
    snapB.pushBaseSnapshotId,
    snapA1.manifest.snapshotId,
    '分叉时必须给出最近一次共同祖先的快照 id',
  )
})

test('簿记按设备分片：本机快照不删外设备账本，清单不含外设备条目（终审 P1-④）', async (t) => {
  const bare = await makeBareRemote(t)
  const at = NOW

  const mkEngine = async (
    deviceId: string,
    tag: string,
    name: string,
    existingRoot?: string,
  ): Promise<{ engine: SnapshotEngine; root: string; warnings: string[] }> => {
    const root = existingRoot ?? (await tempRoot(t, `shard-${tag}-`))
    if (!existingRoot) await git(root, ['init', '-b', 'main'])
    await git(root, ['config', 'user.email', `${tag}@example.test`])
    await git(root, ['config', 'user.name', tag])
    const warnings: string[] = []
    const engine = new SnapshotEngine({
      root,
      deviceId,
      git: new ExecGitRunner({ cwd: root }),
      remote: bare,
      branch: 'main',
      clock: () => at,
      sleep: async () => {},
      onWarn: (message) => warnings.push(message),
      collectState: () => ({
        agents: [
          { agentId: 'lead', workspaceIds: [WORKSPACE], sessions: ['sess-1'], persona: { name, age: 20 } },
        ],
      }),
    })
    return { engine, root, warnings }
  }

  // A 拍一次推远端，远端从此带着 A 的簿记。
  const a = await mkEngine(DEVICE_A, 'dev-a', '大肥鱼')
  const snapA = await a.engine.snapshot('shutdown')
  assert.equal(snapA.pushed, true, `A 必须推上远端；${a.warnings.join(' | ')}`)

  // B clone 后把 A 的快照目录整个从磁盘抹掉——模拟「本机磁盘上不存在外设备簿记」。
  // 旧行为：B 下一次快照的 git add -A 会把 A 的清单文件暂存为删除并推上去，
  // 两台设备互相剪除对方账本，必然分叉（评审实测 dev-A 提交删了 dev-B 清单 42 行）。
  const rootB = await tempRoot(t, 'shard-dev-b-')
  await execFileAsync('git', ['clone', bare, rootB], { windowsHide: true })
  await git(rootB, ['config', 'user.email', 'dev-b@example.test'])
  await git(rootB, ['config', 'user.name', 'dev-b'])
  await rm(join(rootB, 'snapshots'), { recursive: true, force: true })

  const b = await mkEngine(DEVICE_B, 'dev-b', '小狐狸', rootB)
  const snapB = await b.engine.snapshot('shutdown')

  // ① B 的清单只列本机条目：外设备快照目录与日志一概不背。
  // （本机本次的 manifest.json 是 commit 之后才写盘、下次快照才进清单，属已知行为。）
  const paths = snapB.manifest.files.map((file) => file.path)
  for (const path of paths) {
    assert.ok(
      !path.startsWith('snapshots/') || path.includes(`-${DEVICE_B}`),
      `清单不应包含外设备快照目录条目，实际有 ${path}`,
    )
    assert.ok(
      !path.startsWith('journal/devices/') || path.includes(`/${DEVICE_B}/`) || path.includes('/purge/'),
      `清单不应包含外设备 journal 条目，实际有 ${path}`,
    )
  }

  // ② B 的提交没有删除 A 的清单文件——它还在 B 的提交树里。
  const tree = await git(rootB, ['ls-tree', '-r', 'HEAD', '--name-only'])
  const aManifestPath = `snapshots/${snapA.manifest.snapshotId}/manifest.json`
  assert.ok(
    tree.split('\n').includes(aManifestPath),
    `A 的清单文件 ${aManifestPath} 必须在 B 的提交树里保留`,
  )

  // ③ 没有互相剪除，B 顺利推上远端。
  assert.equal(snapB.pushed, true, `B 必须推上远端；${b.warnings.join(' | ')}`)
})
