/**
 * 技能（Skill）的隔离与漫游。
 * ---------------------------------------------------------------------------
 * 三件必须成立的事，一条一条测：
 *
 *   ① **隔离**：A 挂的技能，B 读不到；换工作区也读不到。
 *      技能是"能力"，比记忆更容易出事——串台意味着 B 能调用它根本不该有的工具。
 *
 *   ② **漫游**：快照里必须有一份 `state/skills.json`，且**每个 Agent 都有一条**
 *      （哪怕是空数组）。少了它，B 机恢复后模型"突然不会"它本来会的事，且无报错。
 *
 *   ③ **对齐**：回灌是"清单即真相"，多出来的删掉、少了的补上、开关照抄。
 *      而 `state/skills.json` 不存在时必须**什么都不做**（老快照不能清空本机绑定）。
 */

import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import test, { type TestContext } from 'node:test'
import { promisify } from 'node:util'

import { Journal } from '../src/shared/journal.js'
import type { Scope } from '../src/shared/scope.js'
import {
  countSkills,
  readSkillBindings,
  SkillRegistry,
} from '../src/host/memory/skill-registry.js'
import { rehydrateSkillsFromRepo } from '../src/host/prompt/skill-rehydrate.js'
import { SnapshotEngine } from '../src/host/snapshot/engine.js'
import { ExecGitRunner } from '../src/host/snapshot/git.js'
import { openTestDb, tempRoot } from './helpers/db.js'

const NOW = Date.UTC(2026, 0, 15, 3, 0, 0)
const WORKSPACE = 'ws-skills'
const OTHER_WORKSPACE = 'ws-skills-other'
const DEVICE = 'dev-skills'

const execFileAsync = promisify(execFile)

async function git(cwd: string, args: readonly string[]): Promise<string> {
  const { stdout } = await execFileAsync('git', [...args], { cwd, windowsHide: true })
  return stdout.trim()
}

async function initRepo(t: TestContext): Promise<string> {
  const root = await tempRoot(t, 'skills-')
  await git(root, ['init', '-b', 'main'])
  await git(root, ['config', 'user.email', 'test@example.com'])
  await git(root, ['config', 'user.name', 'skills-test'])
  await git(root, ['config', 'core.autocrlf', 'false'])
  return root
}

function scopeOf(agentId: string, workspaceId = WORKSPACE): Scope {
  return { workspaceId, agentId, deviceId: DEVICE }
}

test('技能绑定按 (workspace, agent) 隔离，跨 Agent 与跨工作区都读不到', async (t) => {
  const db = await openTestDb(t)
  if (!db) return
  const registry = new SkillRegistry({ db, clock: () => NOW })

  const lead = scopeOf('lead')
  const coder = scopeOf('coder')
  await registry.bind(lead, { skillId: 'code-exec', version: '1.2' })
  await registry.bind(coder, { skillId: 'web-search' })

  assert.deepEqual(
    readSkillBindings(db, lead).map((skill) => skill.skillId),
    ['code-exec'],
  )
  assert.deepEqual(
    readSkillBindings(db, coder).map((skill) => skill.skillId),
    ['web-search'],
  )
  // 换工作区：同一个 Agent 也是另一份绑定。
  assert.deepEqual(readSkillBindings(db, scopeOf('lead', OTHER_WORKSPACE)), [])
  // 总览只给数量，不给别人的清单。
  assert.equal(countSkills(db, lead), 1)
  assert.equal(countSkills(db, scopeOf('lead', OTHER_WORKSPACE)), 0)
})

test('bind / unbind / toggle 都会写 journal，且 payload 足以重建（不是空壳）', async (t) => {
  const root = await tempRoot(t, 'skills-journal-')
  const journal = new Journal({ root, deviceId: DEVICE })
  await journal.open()
  const db = await openTestDb(t)
  if (!db) return
  const registry = new SkillRegistry({ db, journal, clock: () => NOW })
  const lead = scopeOf('lead')

  await registry.bind(lead, {
    skillId: 'code-exec',
    version: '1.2',
    config: { timeout: 30 },
  })
  await registry.setEnabled(lead, 'code-exec', false)
  await registry.unbind(lead, 'code-exec')

  const records = await journal.readMerged()
  const binds = records.filter((record) => record.op === 'skill.bind')
  const unbinds = records.filter((record) => record.op === 'skill.unbind')
  assert.ok(binds.length >= 2, '挂载与开关各写一条 skill.bind')
  assert.equal(unbinds.length, 1)

  const first = binds[0] as unknown as Record<string, unknown>
  // 只记 id 的话，重放到新设备会得到一个"存在但不知道是什么"的空技能。
  assert.equal(first.skillId, 'code-exec')
  assert.equal(first.agentId, 'lead')
  assert.equal(first.workspaceId, WORKSPACE)
  assert.equal(first.version, '1.2')
  assert.deepEqual(first.config, { timeout: 30 })
})

test('replaceAll 是对齐不是叠加：清单外的被删掉', async (t) => {
  const db = await openTestDb(t)
  if (!db) return
  const registry = new SkillRegistry({ db, clock: () => NOW })
  const lead = scopeOf('lead')
  await registry.bind(lead, { skillId: 'code-exec' })
  await registry.bind(lead, { skillId: 'web-search' })

  const written = await registry.replaceAll(lead, [{ skillId: 'web-search', enabled: false }], 'snapshot')
  assert.equal(written, 1)
  const after = readSkillBindings(db, lead)
  assert.deepEqual(
    after.map((skill) => [skill.skillId, skill.enabled]),
    [['web-search', false]],
  )
})

test('快照写出 state/skills.json：每个 Agent 一条、按 id 排序、含空技能者', async (t) => {
  const root = await initRepo(t)
  const engine = new SnapshotEngine({
    root,
    deviceId: DEVICE,
    git: new ExecGitRunner({ cwd: root }),
    clock: () => NOW,
    collectState: () => ({
      agents: [
        {
          agentId: 'lead',
          workspaceIds: [WORKSPACE],
          persona: { name: '大肥鱼', age: 11, traits: { curiosity: 0.82 }, baselineHash: 'base-v1' },
          skills: [
            { skillId: 'web-search', enabled: true, grantedBy: 'user' },
            { skillId: 'code-exec', version: '1.2', enabled: false, grantedBy: 'user' },
          ],
        },
        // 一个技能都没挂的 Agent 也必须出现：否则恢复端分不清
        // "他没有技能"和"这版快照不记技能"。
        { agentId: 'coder', workspaceIds: [WORKSPACE], persona: { name: '小狐狸', age: 9, traits: {} } },
      ],
    }),
  })

  await engine.snapshot('manual')
  // v0.6.0 起状态文件按设备分目录：state/<deviceId>/skills.json。
  const state = JSON.parse(await readFile(join(root, 'state', DEVICE, 'skills.json'), 'utf8')) as {
    version: number
    agents: { agentId: string; skills: { skillId: string; enabled: boolean }[] }[]
  }
  assert.equal(state.version, 1)
  assert.deepEqual(
    state.agents.map((agent) => agent.agentId).sort(),
    ['coder', 'lead'],
  )
  const lead = state.agents.find((agent) => agent.agentId === 'lead')
  assert.deepEqual(
    lead?.skills.map((skill) => [skill.skillId, skill.enabled]),
    [
      ['code-exec', false],
      ['web-search', true],
    ],
  )
  const coder = state.agents.find((agent) => agent.agentId === 'coder')
  assert.deepEqual(coder?.skills, [])

  // agents.json 是"指针"，只放数量与已启用的 id，不放 config。
  const pointer = JSON.parse(await readFile(join(root, 'state', DEVICE, 'agents.json'), 'utf8')) as {
    version: number
    agents: { agentId: string; skillCount: number; enabledSkillIds: string[] }[]
  }
  assert.equal(pointer.version, 2)
  const leadPointer = pointer.agents.find((agent) => agent.agentId === 'lead')
  assert.equal(leadPointer?.skillCount, 2)
  assert.deepEqual(leadPointer?.enabledSkillIds, ['web-search'])
})

test('回灌：skills.json 存在则对齐，不存在则一条都不动（老快照不能清空本机）', async (t) => {
  const root = await tempRoot(t, 'skills-rehydrate-')
  const db = await openTestDb(t)
  if (!db) return

  // 本机已有绑定，且它是"当前状态"。
  const registry = new SkillRegistry({ db, clock: () => NOW })
  const lead = scopeOf('lead')
  await registry.bind(lead, { skillId: 'local-only' })

  // ① 没有 skills.json：什么都不做。
  const absent = await rehydrateSkillsFromRepo({ db, root, clock: () => NOW })
  assert.equal(absent.present, false)
  assert.deepEqual(
    readSkillBindings(db, lead).map((skill) => skill.skillId),
    ['local-only'],
  )

  // ② 有 skills.json：清单即真相。
  await mkdir(join(root, 'state'), { recursive: true })
  await writeFile(
    join(root, 'state', 'skills.json'),
    JSON.stringify({
      version: 1,
      device: 'dev-other',
      capturedAt: NOW,
      agents: [
        {
          agentId: 'lead',
          workspaceIds: [WORKSPACE],
          skills: [{ skillId: 'code-exec', version: '1.2', enabled: true }],
        },
        { agentId: 'coder', workspaceIds: [WORKSPACE], skills: [{ skillId: 'web-search' }] },
      ],
    }),
    'utf8',
  )
  const applied = await rehydrateSkillsFromRepo({ db, root, clock: () => NOW })
  assert.equal(applied.present, true)
  assert.equal(applied.agents, 2)
  assert.equal(applied.failed, 0)
  assert.deepEqual(
    readSkillBindings(db, lead).map((skill) => [skill.skillId, skill.version, skill.enabled]),
    [['code-exec', '1.2', true]],
  )
  assert.deepEqual(
    readSkillBindings(db, scopeOf('coder')).map((skill) => skill.skillId),
    ['web-search'],
  )
})
