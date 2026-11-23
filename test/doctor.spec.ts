/**
 * doctor 自检单测（D-05 分支一致性）。
 *
 * 真机事故：repo 默认分支 master、配置 branch: main → /save 持续 409 push-failed，
 * 而 GET /doctor 一片全绿——「静默失败」。这里钉死：分支错位必须报 error 并给出
 * 两个方向的修复指引。
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { promisify } from 'node:util'
import { execFile } from 'node:child_process'
import { mkdir } from 'node:fs/promises'
import { join } from 'node:path'

import { tempRoot } from './helpers/db.js'
import { runDoctor } from '../src/host/doctor.js'

const execFileAsync = promisify(execFile)

async function git(cwd: string, args: readonly string[]): Promise<string> {
  const { stdout } = await execFileAsync('git', [...args], { cwd, windowsHide: true })
  return stdout.trim()
}

async function initRepo(t: Parameters<typeof tempRoot>[0], branch: string): Promise<string> {
  const root = await tempRoot(t, `doctor-${branch}-`)
  await git(root, ['init', '-b', branch])
  await git(root, ['config', 'user.email', 'doctor@example.test'])
  await git(root, ['config', 'user.name', 'Doctor'])
  return root
}

test('D-05：doctor 报分支错位（仓库 master vs 配置 main）', async (t) => {
  const root = await initRepo(t, 'master')
  const report = await runDoctor({ root, branch: 'main' })
  const finding = report.findings.find((f) => f.id === 'branch')
  assert.ok(finding, '应产出 branch finding')
  assert.equal(finding!.severity, 'error', '分支错位是致命项（save 会持续 409）')
  assert.match(finding!.detail, /master/, 'detail 要指明仓库当前分支')
  assert.match(finding!.fix ?? '', /checkout|改成/, 'fix 要给出切换或改配置两条路')
})

test('D-05：doctor 分支一致时报 ok', async (t) => {
  const root = await initRepo(t, 'main')
  const report = await runDoctor({ root, branch: 'main' })
  const finding = report.findings.find((f) => f.id === 'branch')
  assert.ok(finding, '应产出 branch finding')
  assert.equal(finding!.severity, 'ok')
})

test('V62-09：doctor 快照计数只数本机，他机目录不误报堆积', async (t) => {
  const root = await initRepo(t, 'main')
  // 本机 2 个 + 他机 8 个 = 10 个目录；旧逻辑总数 10 > keep+3=8 会误报 error。
  await mkdir(join(root, 'snapshots', 'snap-001-devA'), { recursive: true })
  await mkdir(join(root, 'snapshots', 'snap-002-devA'), { recursive: true })
  for (let i = 1; i <= 8; i++) {
    await mkdir(join(root, 'snapshots', `snap-1${i}-devB`), { recursive: true })
  }
  const report = await runDoctor({ root, keep: 5, deviceId: 'devA' })
  assert.equal(report.environment.snapshots, 2, '只数本机快照目录，他机不算')
  const finding = report.findings.find((f) => f.id === 'snapshots')
  assert.ok(finding, '应产出 snapshots finding')
  assert.equal(finding!.severity, 'ok', '本机 2 个在 keep=5 内，不该报堆积')
})
