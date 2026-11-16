/**
 * dsh-shared-memories — 快照引擎
 * ---------------------------------------------------------------------------
 * "停机即快照，开机即还原" 的写半边。三步流水线：
 *
 *   capture() → commit() → rotate() →（可选）push()
 *
 * 关键约束：
 *   - **capture 只读仓库、不改状态**：它把当前所有状态文件（journal / persona /
 *     rules / state）逐个算 sha256，写进 `snapshots/<id>/manifest.json`。
 *   - **commit 才产生 git 历史**，并且一定打 tag（`snap/<snapshotId>`），
 *     因为"回退到某个版本"在体验上必须是**一次点击**，不能让用户面对 commit hash。
 *   - **rotate 是滑窗**：保留最近 N 个，Pin 的永不清；删 tag 的同时删目录，
 *     否则仓库会随着时间无限膨胀（tag 删了文件还在，那是假清理）。
 *   - 纯本地模式（remote 为空）下 push 直接短路，不算失败。
 */

import { mkdir, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises'
import type { Dirent } from 'node:fs'
import { join } from 'node:path'
import type { SkillBinding } from '../../shared/skills.js'
import { normalizeBindings } from '../../shared/skills.js'
import {
  assertGitOk,
  backoffDelay,
  defaultSleep,
  type GitRunner,
  type SleepFn,
} from './git.js'
import {
  hashFile,
  readManifest,
  readPinned,
  snapshotIdOf,
  toPosixPath,
  writeManifest,
  writePinned,
  type SnapshotFileEntry,
  type SnapshotManifest,
  type SnapshotSummary,
  type SnapshotTrigger,
} from './manifest.js'

/** 多智能体总览：快照时必须覆盖**所有**已注册 agent 的人格、技能与会话。 */
export interface SnapshotAgentState {
  readonly agentId: string
  readonly workspaceIds?: readonly string[]
  /** 人格状态（特质、年龄、演化轨迹），原样落到 persona/<agentId>.json。 */
  readonly persona?: Readonly<Record<string, unknown>>
  /** 活跃会话 id 列表，用于"开机后把会话也接回去"。 */
  readonly sessions?: readonly string[]
  /**
   * 技能绑定：落到 `state/skills.json`。
   *
   * 为什么单独一个文件而不是塞进 agents.json：
   *   - agents.json 是**指针**（谁存在、有哪些工作区/会话），给人和工具快速读；
   *   - skills.json 是**状态**（谁挂了什么、版本、开关、参数），体量随技能数增长，
   *     而且恢复时要整体替换。混在一起会让"读指针"这件事变贵，也让 diff 变脏。
   */
  readonly skills?: readonly SkillBinding[]
}

export interface SnapshotState {
  readonly agents: readonly SnapshotAgentState[]
  /** 额外需要纳入快照的仓库相对路径（如自建的 markdown 笔记）。 */
  readonly extraFiles?: readonly string[]
}

export interface SnapshotEngineOptions {
  /** 仓库根（绝对路径）。 */
  readonly root: string
  readonly deviceId: string
  readonly git: GitRunner
  /** 与 schema.ts 的 SCHEMA_VERSION 对齐，恢复时校验。 */
  readonly schemaVersion?: number
  /** 滑动窗口大小，默认 5（PRD 2）。 */
  readonly keep?: number
  readonly pinProtected?: boolean
  /** 单次快照体积上限，默认 256MB。 */
  readonly maxBytes?: number
  readonly remote?: string
  readonly branch?: string
  readonly pushOnCommit?: boolean
  readonly retries?: number
  readonly authorName?: string
  readonly authorEmail?: string
  readonly clock?: () => number
  readonly onWarn?: (message: string) => void
  readonly sleep?: SleepFn
  /** 采集当前多智能体状态；缺省只快照磁盘上已有文件。 */
  readonly collectState?: () => Promise<SnapshotState> | SnapshotState
}

export class SnapshotError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly detail?: unknown,
  ) {
    super(message)
    this.name = 'SnapshotError'
  }
}

export interface SnapshotResult {
  readonly manifest: SnapshotManifest
  readonly commit: string
  readonly tag: string
  readonly pushed: boolean
  readonly pushReason?: string
  readonly removed: readonly string[]
}

/** 这些目录/文件永远不进快照：库文件是派生数据，node_modules 是垃圾。 */
const EXCLUDED_DIRS = new Set(['.git', 'node_modules', 'snapshots', 'lib', 'dist', '.test-build'])
const EXCLUDED_FILES = /^(memory\.db|memory\.db-wal|memory\.db-shm|.*\.log)$/

export class SnapshotEngine {
  readonly #root: string
  readonly #deviceId: string
  readonly #git: GitRunner
  readonly #schemaVersion: number
  readonly #keep: number
  readonly #pinProtected: boolean
  readonly #maxBytes: number
  readonly #remote: string
  readonly #branch: string
  readonly #pushOnCommit: boolean
  readonly #retries: number
  readonly #authorName: string
  readonly #authorEmail: string
  readonly #clock: () => number
  readonly #onWarn: (message: string) => void
  readonly #sleep: SleepFn
  readonly #collectState: (() => Promise<SnapshotState> | SnapshotState) | undefined

  constructor(options: SnapshotEngineOptions) {
    this.#root = options.root
    this.#deviceId = options.deviceId
    this.#git = options.git
    this.#schemaVersion = options.schemaVersion ?? 1
    this.#keep = Math.max(1, options.keep ?? 5)
    this.#pinProtected = options.pinProtected ?? true
    this.#maxBytes = options.maxBytes ?? 268_435_456
    this.#remote = options.remote ?? ''
    this.#branch = options.branch ?? 'main'
    this.#pushOnCommit = options.pushOnCommit ?? true
    this.#retries = Math.max(0, options.retries ?? 3)
    this.#authorName = options.authorName ?? 'dsh-shared-memories'
    this.#authorEmail = options.authorEmail ?? 'shared-memories@localhost'
    this.#clock = options.clock ?? Date.now
    this.#onWarn = options.onWarn ?? (() => {})
    this.#sleep = options.sleep ?? defaultSleep
    this.#collectState = options.collectState
  }

  get root(): string {
    return this.#root
  }

  /**
   * 采集：把状态落成文件并生成带 sha256 的清单。
   * 不碰 git，不产生历史——所以可以在定时器里高频调用而不脏历史。
   */
  async capture(trigger: SnapshotTrigger): Promise<SnapshotManifest> {
    const at = this.#clock()
    const snapshotId = snapshotIdOf(at)
    const state = await this.#materializeState()
    const files = await this.#collectFiles(state)

    const totals = files.reduce(
      (acc, file) => ({ files: acc.files + 1, bytes: acc.bytes + file.bytes }),
      { files: 0, bytes: 0 },
    )
    if (totals.bytes > this.#maxBytes) {
      throw new SnapshotError(
        'snapshot-too-large',
        `快照体积 ${totals.bytes}B 超过上限 ${this.#maxBytes}B；请开启会话日志压缩或调大 snapshot.maxBytes`,
        totals,
      )
    }

    const journalSeq = await this.#collectJournalSeq()
    const manifest: SnapshotManifest = {
      version: 1,
      snapshotId,
      createdAt: at,
      device: this.#deviceId,
      trigger,
      schemaVersion: this.#schemaVersion,
      agentIds: state.agents.map((agent) => agent.agentId).sort(),
      workspaceIds: [
        ...new Set(state.agents.flatMap((agent) => agent.workspaceIds ?? [])),
      ].sort(),
      journalSeq,
      files,
      totals,
      summary: this.#summarize(trigger, state, totals.files, journalSeq),
    }
    await writeManifest(this.#root, manifest)
    return manifest
  }

  /** 提交：`git add -A` → commit → tag。失败一律抛结构化错误。 */
  async commit(manifest: SnapshotManifest): Promise<{ commit: string; tag: string }> {
    await this.#ensureRepo()
    const add = await this.#git.run(['add', '-A'])
    assertGitOk(add, ['add', '-A'], 'git-add-failed')

    const message = `snapshot(${manifest.trigger}): ${manifest.snapshotId} @${this.#deviceId}`
    const commit = await this.#git.run(['commit', '--allow-empty', '-m', message], {
      config: { 'user.name': this.#authorName, 'user.email': this.#authorEmail },
    })
    assertGitOk(commit, ['commit', '-m', message], 'git-commit-failed')

    const head = await this.#git.run(['rev-parse', 'HEAD'])
    assertGitOk(head, ['rev-parse', 'HEAD'], 'git-rev-parse-failed')
    const sha = head.stdout.trim()

    const tag = `snap/${manifest.snapshotId}`
    const tagged = await this.#git.run(['tag', '-f', '-a', tag, '-m', message, sha])
    assertGitOk(tagged, ['tag', tag], 'git-tag-failed')

    return { commit: sha, tag }
  }

  /**
   * 推送，带指数退避重试。
   * 纯本地模式（remote 为空）不是失败，是设计允许的形态。
   */
  async push(): Promise<{ pushed: boolean; reason?: string }> {
    if (!this.#remote.trim()) return { pushed: false, reason: 'no-remote' }
    await this.#ensureRemote()
    let lastError: unknown
    for (let attempt = 0; attempt <= this.#retries; attempt++) {
      const result = await this.#git.run(['push', '--tags', 'origin', this.#branch])
      if (result.code === 0) return { pushed: true }
      lastError = result.stderr.trim() || `exit ${result.code}`
      if (attempt < this.#retries) {
        const delay = backoffDelay(attempt)
        this.#onWarn(`push 失败（第 ${attempt + 1} 次）：${String(lastError)}；${delay}ms 后重试`)
        await this.#sleep(delay)
      }
    }
    throw new SnapshotError('git-push-failed', `push 最终失败：${String(lastError)}`, lastError)
  }

  /**
   * 保证 `origin` 就位。
   *
   * 不是可选的礼貌步骤：`git push origin` 在没配 remote 的仓库里会直接报
   * "fatal: 'origin' does not appear to be a git repository"。而"新机器、空仓库"
   * 恰恰是本插件的主场景——用户只在配置里填了 `repo.remote`，没有任何人会替他
   * 执行 `git remote add`。少了这一步，第一次开机快照就推不上去。
   */
  async #ensureRemote(): Promise<void> {
    const remote = this.#remote.trim()
    const current = await this.#git.run(['remote', 'get-url', 'origin'])
    if (current.code !== 0) {
      const added = await this.#git.run(['remote', 'add', 'origin', remote])
      assertGitOk(added, ['remote', 'add', 'origin', remote], 'git-remote-add-failed')
      return
    }
    // 地址改过（换仓库、换账号）时对齐，避免一直推到旧地方。
    if (current.stdout.trim() === remote) return
    const updated = await this.#git.run(['remote', 'set-url', 'origin', remote])
    assertGitOk(updated, ['remote', 'set-url', 'origin', remote], 'git-remote-add-failed')
  }

  /**
   * 滑窗清理：保留最近 `keep` 个（按 snapshotId 字典序 = 时间序），
   * Pin 过的一律跳过。删 tag 的同时删目录，并提交这次清理。
   */
  async rotate(): Promise<{ removed: string[]; kept: string[] }> {
    const pinned = this.#pinProtected ? await readPinned(this.#root) : new Set<string>()
    const all = (await this.#listSnapshotIds()).sort()
    const keep = new Set<string>(all.slice(Math.max(0, all.length - this.#keep)))
    for (const id of pinned) if (all.includes(id)) keep.add(id)

    const removed: string[] = []
    for (const id of all) {
      if (keep.has(id)) continue
      removed.push(id)
      const tag = `snap/${id}`
      const deleted = await this.#git.run(['tag', '-d', tag])
      // tag 不存在不算错：可能已经被别的设备删掉了。
      if (deleted.code !== 0 && !/not found/i.test(deleted.stderr)) {
        this.#onWarn(`删除 tag ${tag} 失败：${deleted.stderr.trim()}`)
      }
      await rm(join(this.#root, 'snapshots', id), { recursive: true, force: true })
    }

    if (removed.length > 0) {
      const add = await this.#git.run(['add', '-A'])
      assertGitOk(add, ['add', '-A'], 'git-add-failed')
      const commit = await this.#git.run(
        ['commit', '--allow-empty', '-m', `chore(snapshot): prune ${removed.length} old snapshot(s)`],
        { config: { 'user.name': this.#authorName, 'user.email': this.#authorEmail } },
      )
      if (commit.code !== 0) this.#onWarn(`清理提交失败：${commit.stderr.trim()}`)
    }

    return { removed, kept: [...keep].sort() }
  }

  /** 完整流水线：capture → commit → rotate → push。 */
  async snapshot(trigger: SnapshotTrigger): Promise<SnapshotResult> {
    const manifest = await this.capture(trigger)
    const { commit, tag } = await this.commit(manifest)
    const finalManifest: SnapshotManifest = { ...manifest, commit, tag }
    await writeManifest(this.#root, finalManifest)

    // 注意顺序：先 rotate 再 push，这样推送的就是"已经清理干净"的状态。
    const { removed } = await this.rotate()
    const push = this.#pushOnCommit ? await this.push() : { pushed: false, reason: 'disabled' }
    return {
      manifest: finalManifest,
      commit,
      tag,
      pushed: push.pushed,
      pushReason: push.reason,
      removed,
    }
  }

  /** UI 时间轴数据源：按时间倒序。 */
  async history(): Promise<SnapshotSummary[]> {
    const pinned = await readPinned(this.#root)
    const ids = await this.#listSnapshotIds()
    const out: SnapshotSummary[] = []
    for (const id of ids) {
      try {
        const manifest = await readManifest(this.#root, id)
        out.push({
          snapshotId: manifest.snapshotId,
          createdAt: manifest.createdAt,
          device: manifest.device,
          trigger: manifest.trigger,
          summary: manifest.summary,
          files: manifest.totals.files,
          bytes: manifest.totals.bytes,
          pinned: pinned.has(manifest.snapshotId),
          commit: manifest.commit,
        })
      } catch (error) {
        this.#onWarn(`快照清单不可读（${id}）：${error instanceof Error ? error.message : String(error)}`)
      }
    }
    return out.sort((a, b) => b.createdAt - a.createdAt)
  }

  /** Pin / 取消 Pin。 */
  async setPinned(snapshotId: string, pinned: boolean): Promise<void> {
    // 先验存在性：Pin 一个不存在的 id 会写进 pinned.json 并永久占一个"保留位"，
    // 用户以为"钉住了某个版本"，实际钉住的是空气——这类静默比报错坏得多。
    await this.#assertSnapshotExists(snapshotId)
    const current = await readPinned(this.#root)
    if (pinned) current.add(snapshotId)
    else current.delete(snapshotId)
    await writePinned(this.#root, current)
  }

  /** 一键回退：把工作树硬切到某个快照，并生成一个新 commit（保留"回退过"这件事）。 */
  async rollback(snapshotId: string): Promise<{ commit: string }> {
    await this.#assertSnapshotExists(snapshotId)
    const tag = `snap/${snapshotId}`
    const checkout = await this.#git.run(['checkout', tag, '--', '.'])
    assertGitOk(checkout, ['checkout', tag], 'git-checkout-failed')
    const add = await this.#git.run(['add', '-A'])
    assertGitOk(add, ['add', '-A'], 'git-add-failed')
    const commit = await this.#git.run(
      ['commit', '--allow-empty', '-m', `revert: rollback to ${snapshotId}`],
      { config: { 'user.name': this.#authorName, 'user.email': this.#authorEmail } },
    )
    assertGitOk(commit, ['commit', '-m', 'rollback'], 'git-commit-failed')
    const head = await this.#git.run(['rev-parse', 'HEAD'])
    assertGitOk(head, ['rev-parse', 'HEAD'], 'git-rev-parse-failed')
    return { commit: head.stdout.trim() }
  }

  // ── 内部 ────────────────────────────────────────────────────────────────

  /** 快照 tag 是否存在。Pin / Rollback 共用同一把尺子。 */
  async #assertSnapshotExists(snapshotId: string): Promise<void> {
    const ref = await this.#git.run(['rev-parse', '--verify', '--quiet', `refs/tags/snap/${snapshotId}`])
    if (ref.code !== 0) {
      throw new SnapshotError('snapshot-not-found', `找不到快照 ${snapshotId}`, { snapshotId })
    }
  }

  /** 仓库为空时 `git init`（纯本地模式也这么用）。 */
  async #ensureRepo(): Promise<void> {
    const probe = await this.#git.run(['rev-parse', '--git-dir'])
    if (probe.code !== 0) {
      const init = await this.#git.run(['init', '-b', this.#branch])
      if (init.code !== 0) {
        throw new SnapshotError('git-init-failed', `git init 失败：${init.stderr.trim()}`)
      }
      await this.#git.run(['add', '-A'])
      await this.#git.run(['commit', '--allow-empty', '-m', 'chore: init shared-memories repo'], {
        config: { 'user.name': this.#authorName, 'user.email': this.#authorEmail },
      })
    }
    // 新旧仓库都钉死行尾策略：清单里记的是工作区字节的 sha256。
    // 一旦 git 把 LF 转成 CRLF（Windows 默认 core.autocrlf=true），恢复时的校验
    // 就会把"一次完全正常的拉取"判成 snapshot-corrupt——假篡改比真篡改更难查。
    await this.#pinLineEndings()
  }

  /** 关掉文本行尾转换，让"存进去的字节"和"校验的字节"是同一份。 */
  async #pinLineEndings(): Promise<void> {
    for (const [key, value] of [
      ['core.autocrlf', 'false'],
      ['core.eol', 'lf'],
    ] as const) {
      const result = await this.#git.run(['config', key, value])
      if (result.code !== 0) this.#onWarn(`设置 ${key}=${value} 失败：${result.stderr.trim()}`)
    }
  }

  /** 把多智能体状态写成磁盘文件，使其进入 sha256 清单。 */
  async #materializeState(): Promise<SnapshotState> {
    if (!this.#collectState) return { agents: [] }
    const state = await this.#collectState()

    const personaDir = join(this.#root, 'persona')
    const stateDir = join(this.#root, 'state')
    await mkdir(personaDir, { recursive: true })
    await mkdir(stateDir, { recursive: true })
    for (const agent of state.agents) {
      if (!agent.persona) continue
      await writeFile(
        join(personaDir, `${sanitizeName(agent.agentId)}.json`),
        `${JSON.stringify(agent.persona, null, 2)}\n`,
        'utf8',
      )
    }
    await writeFile(
      join(stateDir, 'agents.json'),
      `${JSON.stringify(
        {
          version: 2,
          device: this.#deviceId,
          capturedAt: this.#clock(),
          agents: state.agents.map((agent) => ({
            agentId: agent.agentId,
            workspaceIds: agent.workspaceIds ?? [],
            sessions: agent.sessions ?? [],
            hasPersona: Boolean(agent.persona),
            // 只放数量与 id：完整绑定（版本/开关/参数）在 state/skills.json。
            skillCount: agent.skills?.length ?? 0,
            enabledSkillIds: (agent.skills ?? [])
              .filter((skill) => skill.enabled)
              .map((skill) => skill.skillId),
          })),
        },
        null,
        2,
      )}\n`,
      'utf8',
    )
    await this.#writeSkillState(stateDir, state)
    return state
  }

  /**
   * 技能绑定落盘。
   *
   * 三件必须做对的事：
   *   1. 即使某个 Agent 一个技能都没有，也要写一条空记录 —— 否则恢复端无法区分
   *      "这人没有技能"和"这个版本的快照不记技能"，前者要清空、后者要保留本机现状。
   *   2. 按 id 排序（`normalizeBindings` 已保证）：顺序抖动会让每次快照都产生 diff。
   *   3. 带上 `workspaceIds`：绑定是 (workspace, agent) 二元组，不能丢维度。
   */
  async #writeSkillState(stateDir: string, state: SnapshotState): Promise<void> {
    const agents = state.agents.map((agent) => ({
      agentId: agent.agentId,
      workspaceIds: agent.workspaceIds ?? [],
      skills: normalizeBindings(agent.skills ?? []).map((skill) => ({
        skillId: skill.skillId,
        version: skill.version ?? '',
        enabled: skill.enabled,
        config: skill.config ?? {},
        grantedBy: skill.grantedBy ?? 'user',
      })),
    }))
    await writeFile(
      join(stateDir, 'skills.json'),
      `${JSON.stringify({ version: 1, device: this.#deviceId, capturedAt: this.#clock(), agents }, null, 2)}\n`,
      'utf8',
    )
  }

  /** 递归收集状态文件（排除派生数据与快照自身）。 */
  async #collectFiles(state: SnapshotState): Promise<SnapshotFileEntry[]> {
    const out: SnapshotFileEntry[] = []
    let root: string
    try {
      root = this.#root
      await stat(root)
    } catch {
      return out
    }

    const walk = async (dir: string): Promise<void> => {
      // 显式标注 Dirent[]：`Awaited<ReturnType<typeof readdir>>` 会命中重载里的
      // Buffer 版本，于是 entry.name 变成 Buffer，后面所有 string 操作全废。
      let entries: Dirent[]
      try {
        entries = await readdir(dir, { withFileTypes: true })
      } catch {
        return
      }
      for (const entry of entries) {
        const absolute = join(dir, entry.name)
        if (entry.isDirectory()) {
          if (EXCLUDED_DIRS.has(entry.name)) continue
          await walk(absolute)
          continue
        }
        if (!entry.isFile()) continue
        if (EXCLUDED_FILES.test(entry.name)) continue
        if (entry.name.endsWith('.db') || entry.name.endsWith('.db-wal')) continue
        const { sha256, bytes } = await hashFile(absolute)
        const path = toPosixPath(root, absolute)
        out.push({ path, sha256, bytes, kind: kindOf(path) })
      }
    }

    await walk(root)
    // 显式声明的额外文件：不在仓库根下也要纳入（内容一致才会计入）。
    for (const extra of state.extraFiles ?? []) {
      const absolute = join(root, extra)
      try {
        const { sha256, bytes } = await hashFile(absolute)
        out.push({ path: toPosixPath(root, absolute), sha256, bytes, kind: 'meta' })
      } catch {
        this.#onWarn(`额外文件不存在，已跳过：${extra}`)
      }
    }
    return out.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))
  }

  /** 每个设备 journal 的最大 seq，恢复后做增量回放用。 */
  async #collectJournalSeq(): Promise<Record<string, number>> {
    const dir = join(this.#root, 'journal', 'devices')
    const out: Record<string, number> = {}
    let devices: string[]
    try {
      devices = (await readdir(dir, { withFileTypes: true }))
        .filter((entry) => entry.isDirectory())
        .map((entry) => entry.name)
    } catch {
      return out
    }
    for (const device of devices) {
      const files = (await readdir(join(dir, device))).filter((name) => name.endsWith('.jsonl')).sort()
      let max = 0
      for (const file of files) {
        const content = await readFile(join(dir, device, file), 'utf8')
        for (const line of content.split('\n')) {
          if (!line.trim()) continue
          try {
            const record = JSON.parse(line) as { seq?: number }
            if (typeof record.seq === 'number' && record.seq > max) max = record.seq
          } catch {
            // 坏行跳过：恢复流程自己会再报一次。
          }
        }
      }
      out[device] = max
    }
    return out
  }

  async #listSnapshotIds(): Promise<string[]> {
    try {
      const entries = await readdir(join(this.#root, 'snapshots'), { withFileTypes: true })
      return entries.filter((entry) => entry.isDirectory()).map((entry) => entry.name)
    } catch {
      return []
    }
  }

  #summarize(
    trigger: SnapshotTrigger,
    state: SnapshotState,
    files: number,
    journalSeq: Readonly<Record<string, number>>,
  ): string {
    const devices = Object.keys(journalSeq).length
    const agents = state.agents.length
    const reasons: Record<SnapshotTrigger, string> = {
      interval: '定时',
      idle: '空闲',
      shutdown: '关机',
      manual: '手动',
      'pre-rollback': '回退前保护',
    }
    return `${reasons[trigger]}快照 · ${agents} 个智能体 · ${files} 个文件 · ${devices} 台设备日志`
  }
}

function kindOf(path: string): SnapshotFileEntry['kind'] {
  if (path.startsWith('journal/')) return 'journal'
  if (path.startsWith('persona/')) return 'persona'
  if (path.startsWith('rules/')) return 'rules'
  if (path.startsWith('state/')) return 'state'
  return 'meta'
}

/** agentId 可能包含路径分隔符（理论上不该有），落文件名前先消毒。 */
function sanitizeName(value: string): string {
  return value.replace(/[^0-9A-Za-z._-]/g, '_').slice(0, 120) || 'anonymous'
}
