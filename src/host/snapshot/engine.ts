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
import { join, resolve } from 'node:path'
import { SCHEMA_VERSION } from '../storage/schema.js'
import type { SkillBinding } from '../../shared/skills.js'
import { normalizeBindings } from '../../shared/skills.js'
import type { UserProfile } from '../../shared/user-profile.js'
import type { PersonaIdentity } from '../../shared/persona-identity.js'
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
  /**
   * 用户画像：落到 `state/user-profile.json`。
   *
   * 它是**按 workspace** 的，不属于任何一个 agent，所以不能塞进 agents[]。
   * 换机器恢复时若丢了它，Agent 人格还在、记忆还在，但它会忘了"对面是谁"——
   * 于是又开始从 README 署名里猜人名。这类"看起来只是称呼错了"的退化，
   * 比丢一条记忆更伤信任。
   */
  readonly userProfiles?: readonly UserProfile[]
  /**
   * 会话 → 人格 绑定：落到 `state/persona-identity.json`。
   *
   * 少了它，"人格漫游"只成功一半：设备 B 恢复了人物数据，但 B 上开的新会话
   * 没有任何绑定记录，于是又退回"新会话 = 新人格 = 空记忆"。
   */
  readonly personaIdentities?: readonly PersonaIdentity[]
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
    this.#schemaVersion = options.schemaVersion ?? SCHEMA_VERSION
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
    const snapshotId = await this.#uniqueSnapshotId(at)
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
    // annotated tag 同样需要 committer 身份：commit 传了 -c 而这里漏掉时，
    // 无全局 git 身份的环境会在 tag 这一步 exit 128「Committer identity unknown」，
    // 使 snapshot 在 commit 之后、rotate/push 之前抛错，整个漫游静默失效。
    const tagged = await this.#git.run(['tag', '-f', '-a', tag, '-m', message, sha], {
      config: { 'user.name': this.#authorName, 'user.email': this.#authorEmail },
    })
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
      // 分支与 tag 分开推：
      //   - 分支是数据本身，必须成功，失败按分叉/网络分别处理。
      //   - tag 只是书签，且 git 不允许改写远端同名 tag。两台设备在同一秒各拍一次时
      //     会产生同名 `snap/<id>`，把 tag 和分支塞进同一条 push 会让整条命令返回
      //     非零（`! [rejected] ... (already exists)`），真机上表现为"push 失败 →
      //     退避重试 → 秒级延迟"，CI 上更会叠加 unref 的 sleep 被判定测试挂起。
      //     分支已经推上去就说明数据到了，tag 冲突告警即可，不算整体失败。
      const branchPush = await this.#git.run(['push', 'origin', this.#branch])
      if (branchPush.code !== 0) {
        lastError = branchPush.stderr.trim() || `exit ${branchPush.code}`
        // 远端有本地没有的提交（另一台设备先推过）：push 会被 rejected，重试多少次都一样。
        // 只有一次机会 pull --rebase，把本地提交垫到远端之上再推；rebase 本身冲突则放弃，
        // 交给冷启动的 restore 流程走 pull-conflict 分支让用户人工处理。
        if (isPushDiverged(String(lastError)) && attempt === 0) {
          // --autostash：push 之前 rotate() 已经删掉了旧快照目录（工作区因此变脏），
          // 不加 autostash 时 rebase 会直接拒绝「You have unstaged changes」，
          // 分叉就再也自愈不了，只能整次 push 失败降级。
          const pulled = await this.#git.run(['pull', '--rebase', '--autostash', 'origin', this.#branch])
          if (pulled.code === 0) continue
          // rebase 撞 AA/UU（两台设备都改过同一批共享 state/*.json）会失败，此时
          // 必须 abort：否则仓库被留在 rebase-merge 中间态 + 脏索引，之后每次 push 都
          // 报「already a rebase-merge directory」，机器永久卡死（评价 1/2 实测 P0）。
          const aborted = await this.#git.run(['rebase', '--abort'])
          if (aborted.code !== 0) {
            this.#onWarn(`rebase --abort 失败：${aborted.stderr.trim() || `exit ${aborted.code}`}`)
          }
          // 分叉且无法自动合并是「一等状态」，不是可重试的网络抖动：直接抛，交给上层
          // 把 pushed=false / reason=diverged 冒到 API 与前端，让用户知道同步已停摆。
          throw new SnapshotError(
            'push-diverged',
            `本机与远端历史分叉且自动合并失败：${pulled.stderr.trim() || `exit ${pulled.code}`}`,
            pulled.stderr,
          )
        }
        if (attempt < this.#retries) {
          const delay = backoffDelay(attempt)
          this.#onWarn(`push 失败（第 ${attempt + 1} 次）：${String(lastError)}；${delay}ms 后重试`)
          await this.#sleep(delay)
        }
        continue
      }

      const tagPush = await this.#git.run(['push', '--tags', 'origin'])
      if (tagPush.code !== 0) {
        // 分支已在远端，漫游数据完整；tag 被拒只会少一个书签，不影响 restore。
        this.#onWarn(`分支已推送，但 tag 推送被拒（不影响漫游）：${tagPush.stderr.trim() || `exit ${tagPush.code}`}`)
      }
      return { pushed: true }
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
      // 目录删除失败不致命：Windows 上目录可能被别的进程短暂占用（EPERM），
      // 抛错会让整条快照失败、上层疯狂重试。降级为 warn，留到下次 rotate 再清。
      try {
        await rm(join(this.#root, 'snapshots', id), { recursive: true, force: true })
      } catch (error) {
        this.#onWarn(
          `删除快照目录 ${id} 失败（下次 rotate 重试）：${error instanceof Error ? error.message : String(error)}`,
        )
      }
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

    // 远端 tag 同步删除（隐私 P0）：rotate 只删本地 tag 的话，远端旧 tag 会让已销毁的
    // 明文永远可达——`git gc --aggressive --prune=now` 也清不掉（tag 使提交保持可达）。
    // 把删除推到远端，让「逻辑删除」在远端同样生效；真正的历史物理擦除仍靠 opt-in
    // filter-repo（README「销毁」两档：逻辑删除默认 / 物理擦除可选）。
    if (removed.length > 0 && this.#remote.trim()) {
      const remoteTags = removed.map((id) => `snap/${id}`)
      const del = await this.#git.run(['push', 'origin', '--delete', ...remoteTags])
      if (
        del.code !== 0 &&
        !/remote ref does not exist|unable to delete|does not exist|couldn't find remote ref|no such ref|not found/i.test(
          del.stderr,
        )
      ) {
        this.#onWarn(`删除远端 tag 失败（隐私书签仍留在远端）：${del.stderr.trim() || `exit ${del.code}`}`)
      }
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
    // push 失败不致命：本地快照（capture + commit）已经落地有效，推送只是同步到远端。
    // 若把 push 失败抛成整个快照失败，上层 idle 防抖会因 lastSnapshotAt 未刷新而疯狂重试，
    // 每次重试又 push 失败，git 操作拖死 agent（真机事故：思考 5 分钟无响应）。
    let push: { pushed: boolean; reason?: string }
    if (this.#pushOnCommit) {
      try {
        push = await this.push()
      } catch (error) {
        this.#onWarn(
          `推送失败（本地快照仍有效）：${error instanceof Error ? error.message : String(error)}`,
        )
        // 分叉是「同步已停摆」的一等状态，网络/鉴权失败才是可重试的 push-failed。
        // 两者都要把 pushed=false 冒到上层，让 /save 与前端不再假装「已保存」。
        push = {
          pushed: false,
          reason: error instanceof SnapshotError && error.code === 'push-diverged' ? 'diverged' : 'push-failed',
        }
      }
    } else {
      push = { pushed: false, reason: 'disabled' }
    }
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
    // memory.db 是 gitignore 的派生数据，`git checkout tag -- .` 不会回退它。若保留旧库，
    // 下次冷启动用回退后的旧 journal 增量重放时，tag 之后新增的记忆不会被清掉（回退假成功），
    // 且库与 journal 不一致可能触发 snapshot-corrupt 锁死只读（评价四 P0-4）。删掉强制全量重放。
    await this.#dropDerivedDb()
    const head = await this.#git.run(['rev-parse', 'HEAD'])
    assertGitOk(head, ['rev-parse', 'HEAD'], 'git-rev-parse-failed')
    return { commit: head.stdout.trim() }
  }

  /** 删除派生库文件（memory.db 及 WAL），让下次冷启动从 journal 全量重放。 */
  async #dropDerivedDb(): Promise<void> {
    for (const name of ['memory.db', 'memory.db-wal', 'memory.db-shm']) {
      await rm(join(this.#root, name), { force: true })
    }
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
      // 首次初始化也要先把 .gitignore 落盘再 add，否则 memory.db 会被 add -A 收进首个 commit。
      await this.#ensureGitignore()
      await this.#git.run(['add', '-A'])
      await this.#git.run(['commit', '--allow-empty', '-m', 'chore: init shared-memories repo'], {
        config: { 'user.name': this.#authorName, 'user.email': this.#authorEmail },
      })
    } else {
      // 已存在的仓库也可能是陌生仓库（repo.path 指向了别人的项目目录），
      // 先验证归属，再补 .gitignore（v0.3.5 之前从未写过它）。
      await this.#assertNotNested()
      await this.#assertRepoOwnership()
      await this.#ensureGitignore()
    }
    // 新旧仓库都钉死行尾策略：清单里记的是工作区字节的 sha256。
    // 一旦 git 把 LF 转成 CRLF（Windows 默认 core.autocrlf=true），恢复时的校验
    // 就会把"一次完全正常的拉取"判成 snapshot-corrupt——假篡改比真篡改更难查。
    await this.#pinLineEndings()
  }

  /**
   * 防御「repo.path 是别的 Git 仓库的子目录」：`git rev-parse --git-dir` 会返回
   * 父目录的 .git，probe 成功走 else 分支，随后的 `git add -A` 会把父目录项目文件
   * （含 .env 等敏感文件）一并提交推送（评价四 P0-3 实测复现）。
   *
   * 尺子是 work-tree 顶层：dsm 数据根的 show-toplevel 必须等于数据根本身。
   * Windows 路径大小写不敏感，用 toLowerCase 比较。
   */
  async #assertNotNested(): Promise<void> {
    const toplevel = await this.#git.run(['rev-parse', '--show-toplevel'])
    if (toplevel.code !== 0) return // 无 work tree（如裸仓库），交给后续步骤处理。
    const top = resolve(toplevel.stdout.trim()).toLowerCase()
    const root = resolve(this.#root).toLowerCase()
    if (top !== root) {
      throw new SnapshotError(
        'repo-hijack',
        `repo.path 嵌套在另一个 Git 仓库内（仓库根「${toplevel.stdout.trim()}」≠ 数据根「${this.#root}」），在此 git add -A 会把外层项目文件一并提交推送，拒绝快照`,
        { toplevel: top, root },
      )
    }
  }

  /**
   * 防御「repo.path 指向陌生 git 仓库」：目录里已有一个 git 仓库时，它可能是
   * 用户的项目仓库（origin 指向项目远程）。若直接在这里 `git add -A` + commit +
   * push，会污染外层仓库、并把记忆推送到项目远程。
   *
   * 归属的尺子是 origin：dsm 专用仓库的 origin 要么与配置一致，要么（纯本地）没有。
   * 一旦 origin 指向别处，就是劫持，宁可拒快照也不能往别人的仓库里塞记忆。
   */
  async #assertRepoOwnership(): Promise<void> {
    const url = await this.#git.run(['remote', 'get-url', 'origin'])
    if (url.code !== 0) return // 无 origin：纯本地 dsm 仓库，安全。
    const existing = url.stdout.trim()
    if (this.#remote.trim()) {
      if (existing !== this.#remote) {
        throw new SnapshotError(
          'repo-hijack',
          `repo.path 指向的仓库已绑定 remote「${existing}」，与配置「${this.#remote}」不一致，拒绝快照`,
          { existing, configured: this.#remote },
        )
      }
    } else {
      throw new SnapshotError(
        'repo-hijack',
        `repo.path 指向的仓库已绑定 remote「${existing}」，但未配置同步远端，拒绝快照（这是别人的仓库）`,
        { existing },
      )
    }
  }

  /**
   * 确保数据根有 .gitignore，且 memory.db 不在索引里。
   *
   * memory.db / -wal / -shm 是从 journal 逐条重放出来的派生数据，真相源是
   * journal/*.jsonl。`git add -A` 若不排除它们，会把几 MB 的库文件连同 -wal 一起
   * 提交推送（v0.3.5 及之前就这样），与 schema.ts「库文件永远不进 git」的承诺矛盾。
   * 已跟踪的旧文件用 `git rm --cached --ignore-unmatch` 从索引摘掉（磁盘文件保留），
   * 该命令幂等：文件不在索引时 ignore-unmatch 让它返回成功。
   */
  async #ensureGitignore(): Promise<void> {
    const gi = join(this.#root, '.gitignore')
    const content = [
      '# 派生数据：真相源是 journal/*.jsonl，库文件是重放产物，永不进 git。',
      'memory.db',
      'memory.db-wal',
      'memory.db-shm',
      'memory.db-journal',
      '',
    ].join('\n')
    await writeFile(gi, content, 'utf8')
    await this.#git.run([
      'rm',
      '--cached',
      '--ignore-unmatch',
      '--',
      'memory.db',
      'memory.db-wal',
      'memory.db-shm',
      'memory.db-journal',
    ])
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
          // 注意：不写 device / capturedAt 字段——两者都是每设备可变（deviceId 不同、
          // 墙钟毫秒不同），两台设备在同一逻辑状态下会产出**不同字节**，git rebase 时
          // 制造假的 add/add 冲突（P0-1/P1-B：并发快照卡 rebase 中间态）。deviceId 已由
          // snapshotId（带 -deviceId 后缀）与 journal 记录承载；快照时间由 snapshotId 承载。
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
    await this.#writeUserProfileState(stateDir, state)
    await this.#writeIdentityState(stateDir, state)
    return state
  }

  /**
   * 会话 → 人格 绑定落盘。
   *
   * 和画像、技能同一个理由：恢复端要能区分"这版快照不记绑定"与"绑定是空的"。
   * 没这个文件时恢复端一条都不动（老快照不许把本机的继承关系清空）。
   */
  async #writeIdentityState(stateDir: string, state: SnapshotState): Promise<void> {
    const identities = [...(state.personaIdentities ?? [])]
      .sort((a, b) => (a.workspaceId === b.workspaceId ? a.boundAt - b.boundAt : a.workspaceId.localeCompare(b.workspaceId)))
      .map((identity) => ({
        agentId: identity.agentId,
        workspaceId: identity.workspaceId,
        personaId: identity.personaId,
        boundAt: identity.boundAt,
        lastSeenAt: identity.lastSeenAt,
      }))
    await writeFile(
      join(stateDir, 'persona-identity.json'),
      `${JSON.stringify(
        {
          version: 1,
          // 不写 capturedAt：墙钟每设备不同，会让两台设备同一逻辑状态产出不同字节，
          // 制造假 add/add 冲突（P0-1/P1-B）。快照时间由 snapshotId 承载。
          identities,
        },
        null,
        2,
      )}\n`,
      'utf8',
    )
  }

  /**
   * 用户画像落盘。一个工作区一条，**空画像也写**。
   *
   * 和技能同一个理由：恢复端必须能区分"这个工作区真的有画像但内容为空"与
   * "这版快照根本不记画像"。前者应当覆盖、后者必须原样保留本机现状。
   */
  async #writeUserProfileState(stateDir: string, state: SnapshotState): Promise<void> {
    const profiles = [...(state.userProfiles ?? [])]
      .sort((a, b) => a.workspaceId.localeCompare(b.workspaceId))
      .map((profile) => ({
        workspaceId: profile.workspaceId,
        displayName: profile.displayName,
        preferredAddress: profile.preferredAddress,
        notes: profile.notes,
        updatedAt: profile.updatedAt,
        updatedBy: profile.updatedBy,
      }))
    await writeFile(
      join(stateDir, 'user-profile.json'),
      `${JSON.stringify(
        {
          version: 1,
          profiles,
        },
        null,
        2,
      )}\n`,
      'utf8',
    )
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
      `${JSON.stringify({ version: 1, agents }, null, 2)}\n`,
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
      // purge 设备装的是墓碑（agent.purge），不是真实设备的 seq 水位。墓碑必须
      // 无条件重放，绝不能进 checkpoint 水位——否则未来一旦恢复增量回放
      // （seq > sinceSeq[device]），墓碑会因为 seq<=水位 被跳过，被销毁的 agent 复活。
      if (device === 'purge') continue
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

  /**
   * 生成不与已有快照重名的 id。
   *
   * `snapshotIdOf` 只精确到秒。同一秒内采集两次（固定时钟的测试、idle 与 shutdown
   * 撞在同一秒、两台设备同一秒各拍一次）会得到同一个 id → 同一个 `snap/<id>` tag
   * 被 `git tag -f` 改写 → `git push --tags` 因「远端已有该 tag 且指向别的提交」被
   * 拒：分支其实推上去了，但 push 返回非零，触发退避重试；真机 CI 上再叠加
   * unref 的 sleep，整条测试被判"挂起"直接取消。
   *
   * 跨设备去重：`#listSnapshotIds()` 只看本地 `snapshots/` 目录，看不到另一台设备在
   * 同一秒已经占用的 id。把 deviceId 掺进 id 后，两台设备同秒各拍一次会得到不同 tag，
   * 从根上避免「push --tags 撞名被远端拒」（评价 1/2 实测的跨设备同秒冲突）。
   * 同一台设备同秒仍靠 `-2`/`-3` 递增兜底，字典序仍与时间序一致。
   */
  async #uniqueSnapshotId(at: number): Promise<string> {
    const base = snapshotIdOf(at)
    // 与快照文件命名保持一致：deviceId 里不能有会破坏 tag / 目录路径的字符。
    const device = sanitizeName(this.#deviceId) || 'local'
    const rooted = `${base}-${device}`
    const taken = new Set(await this.#listSnapshotIds())
    if (!taken.has(rooted)) return rooted
    for (let n = 2; n < 1000; n++) {
      const candidate = `${rooted}-${n}`
      if (!taken.has(candidate)) return candidate
    }
    throw new SnapshotError('snapshot-id-exhausted', `同一秒内快照过多，无法为 ${rooted} 分配唯一 id`)
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

/**
 * push 被拒是否因为"远端有本地没有的提交"（非网络抖动、非鉴权失败）。
 * 这类分叉重试多少次都一样，只能 pull --rebase；其它错误（网络、权限）走退避重试。
 */
function isPushDiverged(stderr: string): boolean {
  return /non-fast-forward|fetch first|rejected|tip of your current branch/i.test(stderr)
}
