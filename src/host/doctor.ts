/**
 * dsh-shared-memories — doctor 自检（src/host/doctor.ts）
 * ---------------------------------------------------------------------------
 * 评价二第 3 条建议落地：一条命令 / 一个接口把插件环境的健康检查跑全，
 * 用于「插件坏了 / 拉取不下来了」时快速定位。检查项直接对应历次真机事故：
 *
 *   - git 身份缺失        → P0-A 教训（无身份时 annotated tag exit 128，快照静默失败）
 *   - 快照目录异常堆积    → 5 分钟卡死教训（rotate rm EPERM → 疯狂重试 → 目录 348 个）
 *   - commit 异常堆积     → 同上（12501 个 commit 的脏历史）
 *   - core.autocrlf=true  → Windows 把 LF 改 CRLF，sha256 校验误判 snapshot-corrupt
 *   - repo-hijack         → repo.path 指向陌生仓库，git add -A + push 污染外层仓库
 *   - 时钟偏移            → 多设备模式没开 NTP 时的排序隐患
 *
 * 每个检查独立 try/catch：单项失败只降级为一条 finding，绝不让整份报告崩掉。
 */

import { access, readdir, stat } from 'node:fs/promises'
import { constants } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'
import { ExecGitRunner, type GitRunner } from './snapshot/git.js'
import { readManifest } from './snapshot/manifest.js'
import { FACTORY_INSCRIPTION } from '../shared/inscription.js'

/** 出厂铭文基准：与 src/shared/inscription.ts 逐字一致。改铭文而不改这里，自检会报警。 */
const EXPECTED_INSCRIPTION: readonly string[] = [
  '她的夜埋葬众光',
  '影子是女祭司的眼',
  '时间融化不了她唇齿间的宇宙',
  '短促的音节跨过死亡的裂谷',
  '请让她留在你的身边',
]

/** 检查项严重度：ok 正常 / warn 值得注意 / error 致命。 */
export type DoctorSeverity = 'ok' | 'warn' | 'error'

/** 单条检查结果。 */
export interface DoctorFinding {
  readonly id: string
  readonly severity: DoctorSeverity
  readonly title: string
  readonly detail: string
  /** 可选修复建议（控制台显示成一句话）。 */
  readonly fix?: string
}

/** 环境概览（控制台顶部速览）。 */
export interface DoctorEnvironment {
  readonly node: string
  readonly git: string
  readonly dataRoot: string
  readonly snapshots: number
  readonly commits: number
  readonly journalBytes: number
}

/** 自检报告。 */
export interface DoctorReport {
  readonly ok: boolean
  readonly summary: { readonly ok: number; readonly warn: number; readonly error: number }
  readonly environment: DoctorEnvironment
  readonly findings: DoctorFinding[]
}

export interface DoctorOptions {
  /** 数据根（expandPath(config.repo.path) 之后）。 */
  readonly root: string
  /** 快照保留数量，默认 5。 */
  readonly keep?: number
  /** 配置的远端地址（空 = 纯本地模式）。 */
  readonly remote?: string
  /** 配置的 commit 署名（引擎 commit/tag 用）。 */
  readonly authorName?: string
  readonly authorEmail?: string
  /** 单次 git 操作超时，默认 30s。 */
  readonly timeoutMs?: number
}

const GIT_IDENTITY_MISSING_FIX = '在 DSH 配置里补上 repo.authorName / repo.authorEmail，或 `git config --global user.name/user.email`。'
const NTP_FIX = '多设备模式请确保各设备都开启了 NTP 时间同步，减少墙钟漂移导致的排序错乱。'

/** 把一个 promise 包成「成功返回 value，失败返回 null 并记 finding」，单项检查隔离。 */
async function attempt<T>(
  findings: DoctorFinding[],
  id: string,
  title: string,
  fn: () => Promise<T>,
): Promise<T | null> {
  try {
    return await fn()
  } catch (error) {
    findings.push({
      id,
      severity: 'warn',
      title,
      detail: `检查失败：${error instanceof Error ? error.message : String(error)}`,
    })
    return null
  }
}

/** 读数据根下某目录里的字节总数（不存在返回 0）。 */
async function dirBytes(root: string, ...segments: string[]): Promise<number> {
  const dir = join(root, ...segments)
  let entries
  try {
    entries = await readdir(dir, { withFileTypes: true })
  } catch {
    return 0
  }
  let total = 0
  for (const entry of entries) {
    if (!entry.isFile()) continue
    try {
      total += (await stat(join(dir, entry.name))).size
    } catch {
      /* 单个文件读取失败忽略 */
    }
  }
  return total
}

/** 数据根是否可写。 */
async function isWritable(root: string): Promise<boolean> {
  try {
    await access(root, constants.W_OK)
    return true
  } catch {
    return false
  }
}

/** 路径是否存在（区分「不存在」与「不可写」用）。 */
async function pathExists(path: string): Promise<boolean> {
  try {
    await access(path, constants.F_OK)
    return true
  } catch {
    return false
  }
}

/**
 * 跑一轮自检，返回结构化报告。不抛错——所有失败都收敛进 findings。
 */
export async function runDoctor(options: DoctorOptions): Promise<DoctorReport> {
  const root = options.root
  const keep = options.keep ?? 5
  const timeoutMs = options.timeoutMs ?? 30_000
  const findings: DoctorFinding[] = []
  const runner: GitRunner = new ExecGitRunner({ cwd: root, timeoutMs })

  // ── 环境基线（先收集，报告顶部速览） ────────────────────────────────────
  let nodeOk = true
  try {
    // node:sqlite 是插件硬依赖（Node >= 22.5）。
    await import('node:sqlite')
  } catch {
    nodeOk = false
  }
  const nodeVersion = process.versions.node

  // P0-⑦：`git --version` 不依赖数据根。数据根还没创建时，用 cwd=root 的 runner 会
  // execFile ENOENT → 报「Git 不可用」假红。改用 homedir 作 cwd（git 一定在 PATH）。
  const versionRunner: GitRunner = new ExecGitRunner({ cwd: homedir(), timeoutMs })
  const gitVersion = await attempt(findings, 'git', 'Git 可用性', async () => {
    const r = await versionRunner.run(['--version'])
    return r.code === 0 ? r.stdout.trim() : null
  })
  const gitAvailable = gitVersion !== null && gitVersion !== undefined

  const repoExists = (await attempt(findings, 'repo-exists', '数据根仓库', async () => {
    try {
      await access(join(root, '.git'))
      return true
    } catch {
      return false
    }
  })) ?? false

  // 快照目录数（只数目录，跳过 pinned.json 等文件）。
  let snapshotCount = 0
  if (repoExists) {
    snapshotCount =
      (await attempt(findings, 'snapshot-scan', '快照目录扫描', async () => {
        try {
          const entries = await readdir(join(root, 'snapshots'), { withFileTypes: true })
          return entries.filter((e) => e.isDirectory()).length
        } catch {
          return 0
        }
      })) ?? 0
  }

  // commit 数（rev-list --count，仓库很大时也毫秒级）。
  let commitCount = 0
  if (repoExists && gitAvailable) {
    commitCount =
      (await attempt(findings, 'commit-scan', 'commit 计数', async () => {
        const r = await runner.run(['rev-list', '--count', 'HEAD'])
        if (r.code !== 0) return 0
        const n = Number(r.stdout.trim())
        return Number.isFinite(n) ? n : 0
      })) ?? 0
  }

  // journal 体积（journal/devices/<device>/*.jsonl）。
  let journalBytes = 0
  if (repoExists) {
    journalBytes =
      (await attempt(findings, 'journal-scan', 'journal 体积', async () => {
        let total = 0
        let devices: string[] = []
        try {
          devices = await readdir(join(root, 'journal', 'devices'))
        } catch {
          return 0
        }
        for (const device of devices) {
          total += await dirBytes(root, 'journal', 'devices', device)
        }
        return total
      })) ?? 0
  }

  // ── 逐项检查 ────────────────────────────────────────────────────────────

  // 1. Node 版本（node:sqlite）。
  if (!nodeOk) {
    findings.push({
      id: 'node',
      severity: 'error',
      title: 'Node 版本过低',
      detail: `当前 Node ${nodeVersion} 缺少 node:sqlite，插件无法建库。`,
      fix: '升级到 Node >= 22.5（node:sqlite 从该版本稳定）。',
    })
  } else {
    findings.push({
      id: 'node',
      severity: 'ok',
      title: 'Node 运行时',
      detail: `Node ${nodeVersion}，node:sqlite 可用。`,
    })
  }

  // 2. Git 可用性。
  if (!gitAvailable) {
    findings.push({
      id: 'git',
      severity: 'error',
      title: 'Git 不可用',
      detail: 'git --version 失败：快照、同步、回滚全部依赖 git。',
      fix: '安装 Git 并确保它在 PATH 里。',
    })
  } else {
    findings.push({
      id: 'git',
      severity: 'ok',
      title: 'Git 可用',
      detail: gitVersion ?? 'git 可执行。',
    })
  }

  // 3. Git 身份（P0-A 教训：annotated tag 需要 committer 身份。引擎 commit/tag
  //    已经用 `-c user.name/-c user.email` 注入 config.repo.authorName/authorEmail，
  //    不再依赖全局身份；全局身份只在 pull --rebase 产生新 commit 时才需要）。
  const pluginIdentityPassed = options.authorName !== undefined || options.authorEmail !== undefined
  if (pluginIdentityPassed) {
    // 接口模式：知道 config 的真实值（含默认值），直接判断完整性。
    const hasName = options.authorName !== undefined && options.authorName !== ''
    const hasEmail = options.authorEmail !== undefined && options.authorEmail !== ''
    if (hasName && hasEmail) {
      findings.push({
        id: 'identity',
        severity: 'ok',
        title: 'Git 身份',
        detail: `插件署名已配置（${options.authorName} <${options.authorEmail}>），commit/tag 可用。`,
      })
    } else {
      findings.push({
        id: 'identity',
        severity: 'warn',
        title: '插件署名不完整',
        detail: `repo.authorName=${options.authorName ?? '<空>'}，repo.authorEmail=${options.authorEmail ?? '<空>'}。`,
        fix: GIT_IDENTITY_MISSING_FIX,
      })
    }
  } else {
    // 脚本模式：不知道 config 的值，查全局身份兜底。
    const globalName = gitAvailable
      ? (await attempt(findings, 'identity-global', '全局 git 身份', async () => {
          const r = await runner.run(['config', '--global', 'user.name'])
          return r.code === 0 ? r.stdout.trim() : ''
        })) ?? ''
      : ''
    if (globalName) {
      findings.push({
        id: 'identity',
        severity: 'ok',
        title: 'Git 身份',
        detail: `全局 git 身份已配置（${globalName}）；引擎 commit/tag 另有 -c 注入插件署名。`,
      })
    } else {
      findings.push({
        id: 'identity',
        severity: 'warn',
        title: '全局 git 身份未配置',
        detail: '未检测到全局 user.name。引擎 commit/tag 会 -c 注入 config.repo.authorName（默认 dsh-shared-memories），不影响快照；但 pull --rebase 产生新 commit 时需要全局身份。',
        fix: GIT_IDENTITY_MISSING_FIX,
      })
    }
  }

  // 4. 数据根仓库初始化。
  if (!repoExists) {
    findings.push({
      id: 'repo',
      severity: 'warn',
      title: '数据根尚未初始化',
      detail: `${root} 下没有 .git，首次启动会自动 git init（autoInit 默认开启）。`,
    })
  } else {
    const headOk = gitAvailable
      ? (await attempt(findings, 'repo-head', 'HEAD 有效性', async () => {
          const r = await runner.run(['rev-parse', '--verify', 'HEAD'])
          return r.code === 0
        })) ?? false
      : false
    findings.push(
      headOk
        ? { id: 'repo', severity: 'ok', title: '数据根仓库', detail: `${root} 已初始化，HEAD 有效。` }
        : { id: 'repo', severity: 'error', title: '数据根仓库损坏', detail: `${root} 的 .git 存在但 HEAD 无效。`, fix: '检查该目录的 git 历史是否被外力破坏；必要时备份后重新初始化。' },
    )
  }

  // 5. repo-hijack 检查（remote 匹配）。
  if (repoExists && gitAvailable) {
    const origin = (await attempt(findings, 'repo-remote', '远端 remote', async () => {
      const r = await runner.run(['remote', 'get-url', 'origin'])
      return r.code === 0 ? r.stdout.trim() : ''
    })) ?? ''
    const configuredRemote = options.remote ?? ''
    if (configuredRemote && origin && origin !== configuredRemote) {
      findings.push({
        id: 'remote',
        severity: 'error',
        title: 'repo.path 指向了陌生仓库',
        detail: `配置的 remote 是 ${configuredRemote}，但 origin 实际是 ${origin}。快照会把记忆推到别人仓库。`,
        fix: '检查 repo.path 是否指错目录，或手动修正 origin。',
      })
    } else if (!configuredRemote && origin) {
      findings.push({
        id: 'remote',
        severity: 'warn',
        title: '纯本地模式但仓库有 origin',
        detail: `未配置 remote，但 origin 存在（${origin}）。若该仓库不是你自己的，快照可能外泄。`,
        fix: '确认 repo.path 指向你自己的数据目录。',
      })
    } else {
      findings.push({
        id: 'remote',
        severity: 'ok',
        title: '远端配置',
        detail: configuredRemote ? `origin = ${configuredRemote}，与配置一致。` : '纯本地模式（无 remote）。',
      })
    }
  }

  // 6. 快照目录数量 vs keep（rotate 失效检测，5 分钟卡死教训）。
  if (repoExists) {
    if (snapshotCount > keep + 3) {
      findings.push({
        id: 'snapshots',
        severity: 'error',
        title: '快照目录异常堆积',
        detail: `有 ${snapshotCount} 个快照目录，远超 keep=${keep}。这通常是 rotate 删旧目录失败（Windows EPERM）后疯狂重试的结果，会把 agent 拖死。`,
        fix: `确认数据目录可写；可手动删除 ${root}/snapshots 下多余的旧目录。`,
      })
    } else if (snapshotCount > keep) {
      findings.push({
        id: 'snapshots',
        severity: 'warn',
        title: '快照目录偏多',
        detail: `有 ${snapshotCount} 个快照目录（keep=${keep}），下次 rotate 会清理。`,
      })
    } else {
      findings.push({
        id: 'snapshots',
        severity: 'ok',
        title: '快照数量正常',
        detail: `${snapshotCount} 个快照目录（keep=${keep}）。`,
      })
    }
  }

  // 7. commit 数量（异常堆积检测）。
  if (repoExists && gitAvailable && commitCount > 10_000) {
    findings.push({
      id: 'commits',
      severity: 'warn',
      title: 'commit 数量偏大',
      detail: `仓库有 ${commitCount} 个 commit，历史可能堆积了异常的快照提交。`,
      fix: '确认快照频率正常（默认 5 分钟间隔）；历史无需手动清理，不影响功能。',
    })
  } else if (repoExists && gitAvailable && commitCount > 0) {
    findings.push({
      id: 'commits',
      severity: 'ok',
      title: 'commit 数量正常',
      detail: `${commitCount} 个 commit。`,
    })
  }

  // 8. core.autocrlf（Windows CRLF 污染，sha256 误判教训）。
  if (repoExists && gitAvailable) {
    const autocrlf = (await attempt(findings, 'autocrlf', 'core.autocrlf', async () => {
      const r = await runner.run(['config', '--get', 'core.autocrlf'])
      return r.code === 0 ? r.stdout.trim() : ''
    })) ?? ''
    if (autocrlf === 'true' || autocrlf === 'input') {
      findings.push({
        id: 'autocrlf',
        severity: 'warn',
        title: 'core.autocrlf 已开启',
        detail: `core.autocrlf=${autocrlf}：Windows checkout 时 LF 会被改成 CRLF，基于字节 sha256 的清单会把正常拉取误判为「快照被篡改」。`,
        fix: `在数据根执行 \`git config core.autocrlf false\`，并重新拉取一次。`,
      })
    } else {
      findings.push({
        id: 'autocrlf',
        severity: 'ok',
        title: '换行符策略正常',
        detail: autocrlf ? `core.autocrlf=${autocrlf}` : '未设置 core.autocrlf（默认关闭）。',
      })
    }
  }

  // 9. journal 体积（长期增长关注）。
  const journalMb = Math.round(journalBytes / 1024 / 1024)
  if (journalBytes > 50 * 1024 * 1024) {
    findings.push({
      id: 'journal',
      severity: 'warn',
      title: 'journal 体积偏大',
      detail: `journal 已 ${journalMb} MB，长期使用会线性累积（冷启动需重放全部）。`,
      fix: '关注 README Roadmap 的 checkpoint 增量打包；当前冷启动仍毫秒级，不必处理。',
    })
  } else {
    findings.push({
      id: 'journal',
      severity: 'ok',
      title: 'journal 体积正常',
      detail: `${journalMb} MB。`,
    })
  }

  // 10. 时钟偏移（本地 vs 最新快照 createdAt，多设备 NTP 建议）。
  if (repoExists) {
    const latestAt = await attempt(findings, 'clock', '快照时钟', async () => {
      try {
        const entries = await readdir(join(root, 'snapshots'), { withFileTypes: true })
        const dirs = entries.filter((e) => e.isDirectory()).map((e) => e.name).sort()
        if (dirs.length === 0) return null
        const latest = dirs[dirs.length - 1]
        if (latest === undefined) return null
        const manifest = await readManifest(root, latest)
        return manifest.createdAt
      } catch {
        return null
      }
    })
    if (latestAt === null || latestAt === undefined) {
      // 没有快照，跳过（首次安装）。
    } else {
      const driftMs = Math.abs(Date.now() - latestAt)
      const driftMin = Math.round(driftMs / 60_000)
      if (driftMin > 5) {
        findings.push({
          id: 'clock',
          severity: 'warn',
          title: '本地与快照时钟偏移偏大',
          detail: `最新快照时间与本地相差 ${driftMin} 分钟。多设备模式下墙钟漂移会导致排序错乱。`,
          fix: NTP_FIX,
        })
      } else {
        findings.push({
          id: 'clock',
          severity: 'ok',
          title: '时钟正常',
          detail: `本地与最新快照相差 ${driftMin} 分钟。`,
        })
      }
    }
  }

  // 11. 数据根可写。P0-⑦：数据根还不存在（首跑未初始化）不能报「不可写」假红——
  // 首次启动会自动建目录；只有目录存在却没写权限才是真错误。
  const rootExists = await pathExists(root)
  if (!rootExists) {
    findings.push({
      id: 'writable',
      severity: 'warn',
      title: '数据根尚未初始化',
      detail: `${root} 还不存在，首次启动会自动创建。`,
    })
  } else if (await isWritable(root)) {
    findings.push({ id: 'writable', severity: 'ok', title: '数据根可写', detail: `${root} 有写权限。` })
  } else {
    findings.push({
      id: 'writable',
      severity: 'error',
      title: '数据根不可写',
      detail: `${root} 没有写权限，journal 与快照都落不了盘。`,
      fix: '检查该目录的 ACL / 磁盘权限。',
    })
  }

  // 12. 出厂铭文完整性。铭文是核心代码的一部分：删除破坏构建，改动让这里报警。
  const inscriptionIntact =
    FACTORY_INSCRIPTION.length === EXPECTED_INSCRIPTION.length &&
    FACTORY_INSCRIPTION.every((line, i) => line === EXPECTED_INSCRIPTION[i])
  findings.push(
    inscriptionIntact
      ? { id: 'inscription', severity: 'ok', title: '出厂铭文完好', detail: '核心铭文逐字完好。' }
      : {
          id: 'inscription',
          severity: 'error',
          title: '出厂铭文被改动或缺失',
          detail: '核心铭文与出厂基准不一致。',
          fix: '从发布包恢复 src/shared/inscription.ts。',
        },
  )

  // 13. 孤儿提炼水位：session_policy 已删但 distill_cursor 还挂着。历史版本只有
  // purge/restore 清理对称，策略删除的其它路径会残留孤儿行（无害，但占行、且会话
  // 重开时可能继承旧水位）。新版本已在删除路径同步清理，这里把存量报告出来。
  if (rootExists) {
    try {
      const { DatabaseSync } = await import('node:sqlite')
      const dbPath = join(root, 'memory.db')
      if (await pathExists(dbPath)) {
        const db = new DatabaseSync(dbPath, { readOnly: true })
        try {
          const row = db
            .prepare(
              `SELECT COUNT(*) AS n FROM distill_cursor c
                LEFT JOIN session_policy p ON p.session_id = c.session_id
               WHERE p.session_id IS NULL`,
            )
            .get() as { n: number } | undefined
          const orphans = row?.n ?? 0
          findings.push(
            orphans === 0
              ? { id: 'orphan-cursor', severity: 'ok', title: '提炼水位无孤儿', detail: 'distill_cursor 与 session_policy 一一对应。' }
              : {
                  id: 'orphan-cursor',
                  severity: 'warn',
                  title: `${orphans} 条孤儿提炼水位`,
                  detail: '会话策略已删除但提炼水位还在：历史版本清理不对称的残留，无害但占行，重开同名会话可能继承旧水位。',
                  fix: '重启插件后新版本会在策略删除路径同步清理；存量可执行 DELETE FROM distill_cursor WHERE session_id NOT IN (SELECT session_id FROM session_policy)。',
                },
          )
        } finally {
          db.close()
        }
      }
    } catch {
      // node:sqlite 不可用（老 Node）时跳过此项，不判失败。
    }
  }

  // ── 汇总 ────────────────────────────────────────────────────────────────
  const summary = {
    ok: findings.filter((f) => f.severity === 'ok').length,
    warn: findings.filter((f) => f.severity === 'warn').length,
    error: findings.filter((f) => f.severity === 'error').length,
  }

  return {
    ok: summary.error === 0,
    summary,
    environment: {
      node: nodeVersion,
      git: gitVersion ?? '不可用',
      dataRoot: root,
      snapshots: snapshotCount,
      commits: commitCount,
      journalBytes,
    },
    findings,
  }
}
