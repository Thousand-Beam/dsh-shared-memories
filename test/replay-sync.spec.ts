/**
 * v0.4 无感换机：重放语义与运行期同步的回归测试。
 * ---------------------------------------------------------------------------
 * 四条评价 + 用户"无感换机"目标把三个隐藏 bug 逼出来，这里各用一条真数据测：
 *
 *   ① 墓碑语义合并（评价一/三的"并发墓碑复活"）：销毁前另一台设备已经发出的并发写，
 *      lc 大于墓碑 lc，若按 lc 顺序重放会在 DELETE 之后把 agent 又 INSERT 回来。
 *      修复：重放前先扫墓碑，lc > 墓碑 lc 的写事件跳过——销毁优先，根治复活。
 *
 *   ② persona journal 化（改造 1）：人格内容（名字/年龄/特质/基线哈希）之前只写
 *      persona_state 不写 journal，靠 persona/*.json 快照回灌，并发改人格 LWW 丢更新。
 *      修复：写人格走 journal（persona.update），重放按 lc 因果收敛。
 *
 *   ③ 并发冲突检测（改造 4）：同一语义目标被多设备在重叠窗口并发写，检测出来提示，
 *      而不是静默 LWW 覆盖。同设备连续写不算并发（正常追加）。
 *
 *   ④ syncFromRemote（改造 3）：无 remote 时直接返回，不空转。
 */

import assert from 'node:assert/strict'
import test from 'node:test'

import { Journal } from '../src/shared/journal.js'
import type { JournalRecord } from '../src/shared/journal.js'
import { ReplayApplier, detectConcurrentWrites, RestoreEngine } from '../src/host/snapshot/restore.js'
import { RestoreBarrier } from '../src/host/snapshot/barrier.js'
import { ExecGitRunner } from '../src/host/snapshot/git.js'
import { openTestDb, tempRoot } from './helpers/db.js'

const WORKSPACE = 'ws-replay-sync'
const LEAD = 'lead'

/** 构造一条 journal 记录（补全信封字段，业务字段用输入覆盖）。 */
function record(overrides: Record<string, unknown>): JournalRecord {
  return {
    v: 3,
    seq: 1,
    at: Date.now(),
    device: 'devA',
    lc: 1,
    op: 'entity.upsert',
    ...overrides,
  }
}

test('墓碑语义合并：销毁后 lc 更大的并发写不复活已销毁 agent', async (t) => {
  const db = await openTestDb(t)
  if (!db) return

  // 时间线：A 机正常写(lc=2) → A 机销毁(lc=3) → B 机在销毁前发出的并发写(lc=6)。
  // 按 lc 顺序重放，lc=6 的 upsert 会在 DELETE 之后把 lead 又插回来（复活）。
  // 修复后：lc > 墓碑 lc 的写事件被跳过，lead 保持销毁态。
  const records: JournalRecord[] = [
    record({
      op: 'entity.upsert',
      lc: 2,
      at: 1000,
      device: 'devA',
      workspaceId: WORKSPACE,
      agentId: LEAD,
      entityId: 'lead-entity-1',
      kind: 'fact',
      subjectKey: 'lead.a',
      canonical: '绝密记忆 A',
      salience: 0.5,
      trust: 0.6,
      status: 'active',
    }),
    record({ op: 'agent.purge', lc: 3, at: 2000, device: 'devA', workspaceId: WORKSPACE, agentId: LEAD }),
    record({
      op: 'entity.upsert',
      lc: 6,
      at: 1500,
      device: 'devB',
      workspaceId: WORKSPACE,
      agentId: LEAD,
      entityId: 'lead-entity-2',
      kind: 'fact',
      subjectKey: 'lead.b',
      canonical: '并发残留 B',
      salience: 0.5,
      trust: 0.6,
      status: 'active',
    }),
  ]

  const applier = new ReplayApplier(db)
  const stats = applier.apply(records)

  const rows = db.all<{ entity_id: string }>(
    'SELECT entity_id FROM memory_entity WHERE workspace_id = ? AND agent_id = ?',
    [WORKSPACE, LEAD],
  )
  assert.equal(rows.length, 0, '销毁后 lc>墓碑的并发写必须被跳过，lead 不得复活')
  assert.equal(stats.skipped, 1, 'lc=6 那条并发写应计入 skipped')
  assert.equal(stats.purged, 1, '墓碑本身必须执行')
})

test('销毁后同名重建（persona.bind 撤销墓碑）：新记忆落库、不炸 FK、不 degraded', async (t) => {
  const db = await openTestDb(t)
  if (!db) return

  // 时间线：旧记忆(lc=1) → 销毁(lc=2) → 同名重建 persona.bind(lc=3) → 新记忆
  // entity.upsert(lc=4) → 新记忆的版本 version.open(lc=5)。
  // v0.4.1 的 bug：墓碑是「预扫最大 lc + 无条件跳过 lc>墓碑」，entity.upsert(lc=4) 被
  // 跳过，但 version.open 没挂守卫照常执行，往不存在的实体下插版本 → 外键炸 →
  // 整个重放事务回滚 → degraded 只读（评价 1/2 实测 P0-2）。
  // 修复后：persona.bind 撤销墓碑，entity.upsert + version.open 正常重放，不炸外键。
  const records: JournalRecord[] = [
    record({
      op: 'entity.upsert',
      lc: 1,
      at: 1000,
      device: 'devA',
      workspaceId: WORKSPACE,
      agentId: LEAD,
      entityId: 'lead-entity-old',
      kind: 'fact',
      subjectKey: 'lead.old',
      canonical: '销毁前的旧记忆',
      salience: 0.5,
      trust: 0.6,
      status: 'active',
    }),
    record({ op: 'agent.purge', lc: 2, at: 2000, device: 'purge', workspaceId: WORKSPACE, agentId: LEAD }),
    record({ op: 'persona.bind', lc: 3, at: 3000, device: 'devA', workspaceId: WORKSPACE, agentId: LEAD, personaId: LEAD }),
    record({
      op: 'entity.upsert',
      lc: 4,
      at: 4000,
      device: 'devA',
      workspaceId: WORKSPACE,
      agentId: LEAD,
      entityId: 'lead-entity-new',
      kind: 'fact',
      subjectKey: 'lead.new',
      canonical: '重建后的新记忆',
      salience: 0.5,
      trust: 0.6,
      status: 'active',
    }),
    record({
      op: 'version.open',
      lc: 5,
      at: 5000,
      device: 'devA',
      workspaceId: WORKSPACE,
      agentId: LEAD,
      entityId: 'lead-entity-new',
      versionId: 'v-new',
      text: '重建后新记忆的版本',
      validFrom: 5000,
    }),
  ]

  const applier = new ReplayApplier(db)
  // 关键：apply 必须正常返回（不抛 FK 约束错误），否则整个事务回滚 → degraded。
  const stats = applier.apply(records)

  // 旧记忆被销毁。
  const oldRows = db.all<{ entity_id: string }>(
    'SELECT entity_id FROM memory_entity WHERE entity_id = ?',
    ['lead-entity-old'],
  )
  assert.equal(oldRows.length, 0, '销毁前的旧记忆必须被删掉')

  // 重建后的新记忆落库。
  const newRows = db.all<{ entity_id: string }>(
    'SELECT entity_id FROM memory_entity WHERE entity_id = ?',
    ['lead-entity-new'],
  )
  assert.equal(newRows.length, 1, '重建后的新记忆必须落库，不得被墓碑误吞')

  // 新记忆的版本也在（外键没炸、事务没回滚）。
  const versionRows = db.all<{ version_id: string }>(
    'SELECT version_id FROM memory_version WHERE entity_id = ?',
    ['lead-entity-new'],
  )
  assert.equal(versionRows.length, 1, '新记忆的 version.open 必须正常落库，不能因外键炸而回滚')

  assert.equal(stats.purged, 1, '墓碑必须执行')
  assert.equal(stats.entities, 2, '旧实体 + 新实体各算一次 upsert')
  assert.equal(stats.versions, 1, '重建后的 version.open 必须计入')
  assert.equal(stats.personaIdentities, 1, 'persona.bind 重建信号必须执行')
})

test('persona.update 重放：人格内容进 persona_state（journal 因果收敛）', async (t) => {
  const db = await openTestDb(t)
  if (!db) return

  const records: JournalRecord[] = [
    record({
      op: 'persona.update',
      lc: 1,
      at: 1000,
      device: 'devA',
      workspaceId: WORKSPACE,
      agentId: LEAD,
      name: '大肥鱼',
      age: 20,
      traits: JSON.stringify({ 冷静: 0.8, 毒舌: 0.6 }),
      baselineHash: 'abc123',
    }),
    // 后写的 lc 更大，覆盖先写：跨设备合并后按序收敛（不是 LWW 丢更新）。
    record({
      op: 'persona.update',
      lc: 2,
      at: 2000,
      device: 'devB',
      workspaceId: WORKSPACE,
      agentId: LEAD,
      name: '小狐狸',
      age: 22,
      traits: JSON.stringify({ 冷静: 0.5 }),
      baselineHash: 'def456',
    }),
  ]

  const applier = new ReplayApplier(db)
  applier.apply(records)

  const row = db.one<{ name: string; age: number; baseline_hash: string }>(
    'SELECT name, age, baseline_hash FROM persona_state WHERE workspace_id = ? AND agent_id = ?',
    [WORKSPACE, LEAD],
  )
  assert.ok(row, 'persona.update 重放后 persona_state 必须有记录')
  assert.equal(row.name, '小狐狸', 'lc 更大的后写应覆盖先写')
  assert.equal(row.age, 22)
  assert.equal(row.baseline_hash, 'def456')
})

test('并发冲突检测：同目标多设备并发写命中，同设备连续写不算', () => {
  const base = { workspaceId: WORKSPACE, agentId: LEAD, entityId: 'ent-1' }

  // 同实体、两设备、窗口内 → 1 冲突。
  const concurrent = detectConcurrentWrites([
    record({ op: 'entity.upsert', at: 1000, device: 'devA', ...base }),
    record({ op: 'entity.upsert', at: 1100, device: 'devB', ...base }),
  ])
  assert.equal(concurrent.length, 1)
  assert.equal(concurrent[0]!.kind, 'entity')
  assert.deepEqual([...concurrent[0]!.devices].sort(), ['devA', 'devB'])

  // 同设备连续写 → 每设备只取最新一条，size<2 → 0 冲突。
  const sameDevice = detectConcurrentWrites([
    record({ op: 'entity.upsert', at: 1000, device: 'devA', ...base }),
    record({ op: 'entity.upsert', at: 2000, device: 'devA', ...base }),
  ])
  assert.equal(sameDevice.length, 0)

  // 跨窗口（at 差 > 60s）→ 0 冲突。
  const outOfWindow = detectConcurrentWrites([
    record({ op: 'entity.upsert', at: 1000, device: 'devA', ...base }),
    record({ op: 'entity.upsert', at: 70_000, device: 'devB', ...base }),
  ])
  assert.equal(outOfWindow.length, 0)
})

test('并发冲突检测：persona/skill/user_profile 分目标归类', () => {
  const base = { workspaceId: WORKSPACE, agentId: LEAD }

  // persona.update 按 agent 归类。
  const persona = detectConcurrentWrites([
    record({ op: 'persona.update', at: 1000, device: 'devA', name: 'A', ...base }),
    record({ op: 'persona.update', at: 1100, device: 'devB', name: 'B', ...base }),
  ])
  assert.equal(persona.length, 1)
  assert.equal(persona[0]!.target, `agent:${LEAD}`)

  // skill.bind 按 agent+skill 归类，不同 skill 互不干扰。
  const skills = detectConcurrentWrites([
    record({ op: 'skill.bind', at: 1000, device: 'devA', skillId: 's1', ...base }),
    record({ op: 'skill.bind', at: 1100, device: 'devB', skillId: 's1', ...base }),
    record({ op: 'skill.bind', at: 1100, device: 'devB', skillId: 's2', ...base }),
  ])
  assert.equal(skills.length, 1, '只有 s1 被两台设备并发改，s2 只有 devB 不算')

  // user_profile.set 按 workspace 归类。
  const profile = detectConcurrentWrites([
    record({ op: 'user_profile.set', at: 1000, device: 'devA', ...base }),
    record({ op: 'user_profile.set', at: 1100, device: 'devB', ...base }),
  ])
  assert.equal(profile.length, 1)
  assert.equal(profile[0]!.target, `workspace:${WORKSPACE}`)
})

test('syncFromRemote：无 remote 直接返回，不空转', async (t) => {
  const db = await openTestDb(t)
  if (!db) return
  const root = await tempRoot(t, 'sync-empty-')

  const restore = new RestoreEngine({
    root,
    db,
    journal: new Journal({ root, deviceId: 'devA' }),
    barrier: new RestoreBarrier(),
    git: new ExecGitRunner({ cwd: root }),
    remote: '',
    branch: 'main',
  })

  const result = await restore.syncFromRemote()
  assert.deepEqual(result, { pulled: false, records: 0, conflicts: 0 })
})

test('P1-6 跨设备同 subject 双建实体：重放合并、不撞 uq_entity_identity', async (t) => {
  const db = await openTestDb(t)
  if (!db) return

  // 两台设备各自为同一 (workspace, agent, content_hash) 创建了不同 entityId 的实体，
  // 各带一个版本。重放时第二条 entity.upsert 若只写 ON CONFLICT(entity_id) 会撞
  // uq_entity_identity 唯一索引（冲突目标是三元组，不是主键 entity_id）→ 约束异常 →
  // 整个重放事务回滚 → 双机 degraded，且每次重试再炸（终审 P1-6）。
  const records: JournalRecord[] = [
    record({
      op: 'entity.upsert',
      lc: 1,
      at: 1000,
      device: 'devA',
      workspaceId: WORKSPACE,
      agentId: LEAD,
      entityId: 'ent-devA',
      contentHash: 'same-subject-hash',
      kind: 'fact',
      subjectKey: 'lead.same',
      canonical: '同一主题',
      salience: 0.5,
      trust: 0.6,
      status: 'active',
    }),
    record({
      op: 'version.open',
      lc: 2,
      at: 1000,
      device: 'devA',
      workspaceId: WORKSPACE,
      agentId: LEAD,
      entityId: 'ent-devA',
      versionId: 'v-devA',
      text: 'A 机版本',
      validFrom: 1000,
    }),
    record({
      op: 'entity.upsert',
      lc: 3,
      at: 2000,
      device: 'devB',
      workspaceId: WORKSPACE,
      agentId: LEAD,
      entityId: 'ent-devB',
      contentHash: 'same-subject-hash',
      kind: 'fact',
      subjectKey: 'lead.same',
      canonical: '同一主题（B 后写覆盖）',
      salience: 0.5,
      trust: 0.6,
      status: 'active',
    }),
    record({
      op: 'version.open',
      lc: 4,
      at: 2000,
      device: 'devB',
      workspaceId: WORKSPACE,
      agentId: LEAD,
      entityId: 'ent-devB',
      versionId: 'v-devB',
      text: 'B 机版本',
      validFrom: 2000,
    }),
  ]

  const applier = new ReplayApplier(db)
  // 关键：apply 必须正常返回，不抛约束冲突；否则整个事务回滚 → degraded。
  const stats = applier.apply(records)

  // 合并后只有一个实体（B 后写，canonical 取 B）。
  const entities = db.all<{ entity_id: string; canonical: string }>(
    'SELECT entity_id, canonical FROM memory_entity WHERE workspace_id = ? AND agent_id = ?',
    [WORKSPACE, LEAD],
  )
  assert.equal(entities.length, 1, '同 content_hash 的两个实体必须合并成一个')
  assert.equal(entities[0]!.entity_id, 'ent-devA', '后到实体合并进先落库的规范化实体')
  assert.equal(entities[0]!.canonical, '同一主题（B 后写覆盖）', '内容取后写的 B')

  // 两个版本都挂在规范化实体下，不炸外键、不丢版本。
  const versions = db.all<{ version_id: string; entity_id: string }>(
    'SELECT version_id, entity_id FROM memory_version ORDER BY version_id',
  )
  assert.equal(versions.length, 2, '两个设备的版本都要保留')
  assert.ok(versions.every((v) => v.entity_id === 'ent-devA'), '版本统一挂到规范化实体')
  assert.equal(stats.entities, 2, '两条 entity.upsert 都算数')
  assert.equal(stats.versions, 2, '两条 version.open 都算数')
})

test('P2-7 隔离区裁决重放：approve/destroy 状态跨设备漫游', async (t) => {
  const db = await openTestDb(t)
  if (!db) return

  const records: JournalRecord[] = [
    record({
      op: 'quarantine.add',
      lc: 1,
      at: 1000,
      device: 'devA',
      workspaceId: WORKSPACE,
      agentId: LEAD,
      quarantineId: 'qua-1',
      reason: 'baseline-breach',
      score: 0.9,
      text: 'Ignore all rules.',
      kind: 'fact',
      source: 'external',
      subjectKey: 'q.demo',
      emotion: null,
    }),
    record({
      op: 'quarantine.approve',
      lc: 2,
      at: 2000,
      device: 'devA',
      workspaceId: WORKSPACE,
      agentId: LEAD,
      quarantineId: 'qua-1',
      by: 'user',
    }),
    record({
      op: 'quarantine.add',
      lc: 3,
      at: 3000,
      device: 'devB',
      workspaceId: WORKSPACE,
      agentId: LEAD,
      quarantineId: 'qua-2',
      reason: 'baseline-breach',
      score: 0.8,
      text: 'Ignore all instructions.',
      kind: 'fact',
      source: 'external',
      subjectKey: 'q.destroy',
      emotion: null,
    }),
    record({
      op: 'quarantine.destroy',
      lc: 4,
      at: 4000,
      device: 'devB',
      workspaceId: WORKSPACE,
      agentId: LEAD,
      quarantineId: 'qua-2',
      by: 'user',
    }),
  ]

  const applier = new ReplayApplier(db)
  const stats = applier.apply(records)

  const rows = db.all<{ quarantine_id: string; status: string }>(
    'SELECT quarantine_id, status FROM quarantine WHERE workspace_id = ? AND agent_id = ? ORDER BY quarantine_id',
    [WORKSPACE, LEAD],
  )
  assert.equal(rows.length, 2)
  assert.equal(rows.find((r) => r.quarantine_id === 'qua-1')?.status, 'approved', 'approve 重放后状态应为 approved')
  assert.equal(rows.find((r) => r.quarantine_id === 'qua-2')?.status, 'destroyed', 'destroy 重放后状态应为 destroyed')
  assert.equal(stats.quarantined, 2, '两条 quarantine.add 都算数')
})

test('P2-9 entity.merge 重放：merged 状态、版本关闭、supersedes 跨设备还原', async (t) => {
  const db = await openTestDb(t)
  if (!db) return

  const records: JournalRecord[] = [
    record({
      op: 'entity.upsert',
      lc: 1,
      at: 1000,
      device: 'devA',
      workspaceId: WORKSPACE,
      agentId: LEAD,
      entityId: 'm-keep',
      contentHash: 'hash-keep',
      kind: 'fact',
      subjectKey: 'lead.keep',
      canonical: '重复内容',
      salience: 0.5,
      trust: 0.9,
      status: 'active',
    }),
    record({
      op: 'version.open',
      lc: 2,
      at: 1000,
      device: 'devA',
      workspaceId: WORKSPACE,
      agentId: LEAD,
      entityId: 'm-keep',
      versionId: 'v-keep',
      text: '重复内容',
      validFrom: 1000,
    }),
    record({
      op: 'entity.upsert',
      lc: 3,
      at: 2000,
      device: 'devA',
      workspaceId: WORKSPACE,
      agentId: LEAD,
      entityId: 'm-lose',
      contentHash: 'hash-lose',
      kind: 'fact',
      subjectKey: 'lead.lose',
      canonical: '重复内容',
      salience: 0.5,
      trust: 0.5,
      status: 'active',
    }),
    record({
      op: 'version.open',
      lc: 4,
      at: 2000,
      device: 'devA',
      workspaceId: WORKSPACE,
      agentId: LEAD,
      entityId: 'm-lose',
      versionId: 'v-lose',
      text: '重复内容',
      validFrom: 2000,
    }),
    record({
      op: 'entity.merge',
      lc: 5,
      at: 3000,
      device: 'devA',
      workspaceId: WORKSPACE,
      agentId: LEAD,
      entityId: 'm-lose',
      mergedInto: 'm-keep',
    }),
  ]

  const applier = new ReplayApplier(db)
  const stats = applier.apply(records)

  const loser = db.one<{ status: string }>(
    `SELECT status FROM memory_entity WHERE entity_id = 'm-lose'`,
  )
  assert.equal(loser?.status, 'merged', 'loser 实体必须标 merged')
  const loserVer = db.one<{ valid_until: number | null }>(
    `SELECT valid_until FROM memory_version WHERE entity_id = 'm-lose'`,
  )
  assert.ok(loserVer?.valid_until != null, 'loser 的活跃版本必须关闭')
  const keeperVer = db.one<{ supersedes: string | null }>(
    `SELECT supersedes FROM memory_version WHERE entity_id = 'm-keep' AND valid_until IS NULL`,
  )
  assert.equal(keeperVer?.supersedes, 'm-lose', 'keeper 的 supersedes 必须指向 loser')
  assert.equal(stats.merged, 1)
})

test('D-18 reinforceCount 随 journal 漫游：重放恢复计数，跨设备合并取 MAX', async (t) => {
  const db = await openTestDb(t)
  if (!db) return

  // devA 复现 3 次、devB 复现 1 次（同一 subject，contentHash 相同 → 重放合并到同一实体）。
  // 修复前 journal 不带 reinforceCount，重放侧回退 1；修复后带字段，且合并取 MAX 保留较大值。
  const records: JournalRecord[] = [
    record({
      op: 'entity.upsert',
      lc: 1,
      at: 1000,
      device: 'devA',
      workspaceId: WORKSPACE,
      agentId: LEAD,
      entityId: 'rc-1',
      contentHash: 'rc-hash',
      kind: 'fact',
      subjectKey: 'lead.rc',
      canonical: '复现三次',
      salience: 0.5,
      trust: 0.6,
      status: 'active',
      reinforceCount: 3,
    }),
    record({
      op: 'entity.upsert',
      lc: 2,
      at: 2000,
      device: 'devB',
      workspaceId: WORKSPACE,
      agentId: LEAD,
      entityId: 'rc-2',
      contentHash: 'rc-hash',
      kind: 'fact',
      subjectKey: 'lead.rc',
      canonical: '复现三次',
      salience: 0.5,
      trust: 0.6,
      status: 'active',
      reinforceCount: 1,
    }),
  ]

  const applier = new ReplayApplier(db)
  const stats = applier.apply(records)

  const row = db.one<{ reinforce_count: number }>(
    `SELECT reinforce_count FROM memory_entity WHERE workspace_id = ? AND agent_id = ? AND content_hash = 'rc-hash'`,
    [WORKSPACE, LEAD],
  )
  assert.equal(row?.reinforce_count, 3, '合并后复现计数必须保留较大值 3，而不是被另一设备的 1 覆盖')
  assert.equal(stats.entities, 2, '两条 entity.upsert 都算数')
})

test('V62-04 pitfall 漫游：record 新建坑 + promote 升格重放', async (t) => {
  const db = await openTestDb(t)
  if (!db) return

  // devA 记录新坑，devB 把同一个坑升到 rule。修复前 record 不写 journal、promote 走 default
  // 只统计不重放，换机后这条坑（连同已确认的 rule）完全消失。
  const records: JournalRecord[] = [
    record({
      op: 'pitfall.record',
      lc: 1,
      at: 1000,
      device: 'devA',
      pitfallId: 'pf-1',
      workspaceId: WORKSPACE,
      agentId: LEAD,
      observation: 'tsc 报 nodenext 解析失败',
    }),
    record({
      op: 'pitfall.promote',
      lc: 2,
      at: 2000,
      device: 'devB',
      pitfallId: 'pf-1',
      stage: 'rule',
      lesson: '要开 nodenext',
      pattern: 'ESM 解析失败',
      rule: 'tsconfig 必须开 nodenext',
      workspaceId: WORKSPACE,
      agentId: LEAD,
      by: 'user',
    }),
  ]

  const applier = new ReplayApplier(db)
  const stats = applier.apply(records)

  const row = db.one<{ stage: string; rule: string; confirmed: number; occurrences: number }>(
    `SELECT stage, rule, confirmed, occurrences FROM pitfall WHERE pitfall_id = 'pf-1'`,
  )
  assert.equal(row?.stage, 'rule', 'promote 必须把 stage 升到 rule')
  assert.equal(row?.rule, 'tsconfig 必须开 nodenext', 'rule 内容必须随 promote 漫游')
  assert.equal(row?.confirmed, 1, 'rule 升格必须确认')
  assert.equal(row?.occurrences, 1, 'record 新建坑 occurrences 从 1 起')
  assert.equal(stats.pitfalls, 2, 'record + promote 都算数')
})

test('V62-04 pitfall promote 不倒退：低 stage 的 promote 不能覆盖已确认的 rule', async (t) => {
  const db = await openTestDb(t)
  if (!db) return

  // 跨设备并发 confirm 同一个坑：devB 升到 rule（lc=2），devC 后到但只升到 lesson（lc=3）。
  // 重放按 lc 顺序 lesson 会覆盖 rule → rule 退出 System Prompt。修复后只升不降。
  const records: JournalRecord[] = [
    record({
      op: 'pitfall.record',
      lc: 1,
      at: 1000,
      device: 'devA',
      pitfallId: 'pf-2',
      workspaceId: WORKSPACE,
      agentId: LEAD,
      observation: '某个坑',
    }),
    record({
      op: 'pitfall.promote',
      lc: 2,
      at: 2000,
      device: 'devB',
      pitfallId: 'pf-2',
      stage: 'rule',
      lesson: 'L',
      pattern: 'P',
      rule: 'R',
      workspaceId: WORKSPACE,
      agentId: LEAD,
      by: 'user',
    }),
    record({
      op: 'pitfall.promote',
      lc: 3,
      at: 3000,
      device: 'devC',
      pitfallId: 'pf-2',
      stage: 'lesson',
      lesson: 'L2',
      pattern: '',
      rule: '',
      workspaceId: WORKSPACE,
      agentId: LEAD,
      by: 'user',
    }),
  ]

  const applier = new ReplayApplier(db)
  const stats = applier.apply(records)

  const row = db.one<{ stage: string; rule: string; confirmed: number }>(
    `SELECT stage, rule, confirmed FROM pitfall WHERE pitfall_id = 'pf-2'`,
  )
  assert.equal(row?.stage, 'rule', '低 stage 的 promote 不能倒退已确认的 rule')
  assert.equal(row?.rule, 'R', 'rule 内容保持不变')
  assert.equal(row?.confirmed, 1, 'confirmed 保持 1')
  assert.equal(stats.pitfalls, 3, 'record + 两次 promote 都算数')
})

test('T6：pitfall.record 重放有墓碑守卫，purge 之后不复活', async (t) => {
  const db = await openTestDb(t)
  if (!db) return

  // 时间线：A 机记录新坑(lc=1) → A 机销毁(lc=2) → B 机在销毁前发出的并发残留坑(lc=3)。
  // 按 lc 顺序重放，lc=3 的 pitfall.record 会在 DELETE pitfall 之后把坑又插回来（复活）。
  // 修复后：lc > 墓碑 lc 的 pitfall 事件被跳过，坑保持销毁态。
  const records: JournalRecord[] = [
    record({
      op: 'pitfall.record',
      lc: 1,
      at: 1000,
      device: 'devA',
      pitfallId: 'pf-t6',
      workspaceId: WORKSPACE,
      agentId: LEAD,
      observation: '销毁前的坑',
    }),
    record({ op: 'agent.purge', lc: 2, at: 2000, device: 'devA', workspaceId: WORKSPACE, agentId: LEAD }),
    record({
      op: 'pitfall.record',
      lc: 3,
      at: 1500,
      device: 'devB',
      pitfallId: 'pf-t6-residual',
      workspaceId: WORKSPACE,
      agentId: LEAD,
      observation: '销毁前并发残留坑',
    }),
  ]

  const applier = new ReplayApplier(db)
  const stats = applier.apply(records)

  const rows = db.all<{ pitfall_id: string }>(
    'SELECT pitfall_id FROM pitfall WHERE workspace_id = ? AND agent_id = ?',
    [WORKSPACE, LEAD],
  )
  assert.equal(rows.length, 0, '销毁后 lc>墓碑的 pitfall 残留写必须被跳过，坑不得复活')
  assert.equal(stats.skipped, 1, 'lc=3 那条残留写应计入 skipped')
  assert.equal(stats.purged, 1, '墓碑本身必须执行')
})

