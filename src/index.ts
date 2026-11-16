/**
 * dsh-shared-memories — 宿主入口
 * ---------------------------------------------------------------------------
 * 装配顺序（顺序很重要，改之前先想清楚谁依赖谁）：
 *
 *   ① 立刻建 RestoreBarrier（此时状态 = cold，写入一律被拒）
 *   ② 异步 boot()：开库 → 迁移 → Journal → TemporalTree/ScopedQuery →
 *      RestoreEngine.restoreOnBoot() → ready（或 degraded）
 *   ③ 注册事件（**全部放进 ctx.effect**，插件卸载时随作用域一起销毁）：
 *        agent/created   → await barrier.wait()（PRD 1 的强一致性闸门）
 *        session/flush   → journal.flush() + 空闲防抖快照
 *        agent/disposed  → 关机式快照（多 agent 场景下做去抖合并）
 *        SIGINT/SIGTERM  → 同上，退出前落一次快照
 *   ④ 注册 System Prompt 段：人格 + 已确认 rule/pattern（PRD 7/9）
 *
 * 类型说明：DSH 的事件表是**按安装版本声明合并**进来的，直接 `ctx.on('x')` 会在
 * 宿主小版本变动时编译失败。这里把宿主收敛成本文件的 `SharedHost` 最小接口：
 * 保留编译期检查，又不被宿主内部事件表绑架。
 */

import { homedir, hostname } from 'node:os'
import { join, resolve } from 'node:path'
import { Config, isLocalOnly, type Config as SharedConfig } from './config.js'
import { Journal } from './shared/journal.js'
import { deriveWorkspaceId, type Scope } from './shared/scope.js'
import type { SqlDriver } from './shared/types.js'
import type { SkillBinding } from './shared/skills.js'
import { normalizeBindings } from './shared/skills.js'
import { profileAddress, type UserProfile } from './shared/user-profile.js'
import { UserProfileStore } from './host/memory/user-profile.js'
import { readSkillBindings } from './host/memory/skill-registry.js'
import { SkillRegistry } from './host/memory/skill-registry.js'
import { TemporalTree } from './host/memory/timetree.js'
import { ScopedQuery, type MemoryHit } from './host/memory/scoped-query.js'
import { migrate, SCHEMA_VERSION } from './host/storage/schema.js'
import { openSqliteDriver } from './host/storage/sqlite-driver.js'
import { RestoreBarrier } from './host/snapshot/barrier.js'
import { ExecGitRunner } from './host/snapshot/git.js'
import { SnapshotEngine, type SnapshotAgentState } from './host/snapshot/engine.js'
import type { SnapshotTrigger } from './host/snapshot/manifest.js'
import { RestoreEngine } from './host/snapshot/restore.js'
import { PoisonGuard } from './host/memory/poison.js'
import { Importer } from './host/memory/importer.js'
import { PitfallStore } from './host/memory/pitfall.js'
import { registerRoutes, type MemoriesApiDeps, type WebServerLike } from './host/http/routes.js'

export const name = 'dsh-shared-memories'

/**
 * 硬依赖。两条都不能少，而且原因不一样：
 *
 * - `systemPrompt`：注入 [Persona]/[Rules]/[回忆] 三段要用它的 `section()`。
 * - `webServer`：**必须写进 inject**。cordis 的 apply 时机由 inject 的依赖图决定，
 *   没声明的服务在 apply 时可能还没激活——那时 `ctx.get('webServer')` 返回
 *   `undefined`，控制台的 19 个端点就一个都没注册，前端拿到的全是 404，
 *   而宿主日志里只有一行 warn。这正是"物理库建好了、面板却一直转圈"的真因。
 *   宁可没有 webServer 的宿主里整插件不加载，也不要"加载了但接口不存在"。
 */
export const inject = ['systemPrompt', 'webServer']

export { Config }

const DEVICE_ID_FALLBACK = 'local'

/** PromptSection 的最小形状（宿主真正的类型在 dsh-system-prompt 里，不在这份源码里）。 */
interface PromptSectionLike {
  readonly name: string
  readonly order: number
  readonly text: string | ((context: unknown) => string)
}

/** 宿主里我们真正用到的最小面（见文件头注释）。 */
interface SharedHost {
  effect(callback: () => void | (() => void)): () => void
  on(event: string, listener: (...args: unknown[]) => unknown): () => void
  /** 服务解析：cordis 4 的正规入口是 `ctx.reflect.get(name)`；老宿主上可能只有 `ctx.get`。 */
  reflect?: { get(name: string): unknown }
  get?(service: string): unknown
  logger?: {
    info?: (message: string) => void
    warn?: (message: string) => void
    error?: (message: string) => void
  }
  systemPrompt: {
    section(section: PromptSectionLike): () => void
  }
}

/**
 * 取一个可选服务。两种宿主形态都试：`reflect.get`（cordis 4 反射层）与旧式 `get`。
 * 注意：这里只能取**已经写进 inject** 的服务——未声明的属性在 cordis 的 Proxy 上
 * 直接读会抛错，也拿不到就绪保证。
 */
function lookupService(host: SharedHost, name: string): unknown {
  if (typeof host.reflect?.get === 'function') {
    try {
      return host.reflect.get(name)
    } catch {
      /* 反射层不可用时退回 get() */
    }
  }
  if (typeof host.get === 'function') return host.get(name)
  return undefined
}

/** 装配期可变状态（集中管理，避免散落的模块级变量）。 */
interface Runtime {
  root: string
  workspaceId: string
  deviceId: string
  db?: SqlDriver
  journal?: Journal
  tree?: TemporalTree
  snapshots?: SnapshotEngine
  restore?: RestoreEngine
  booted: boolean
  promptCache: Map<string, string>
  lastSnapshotAt: number
  snapshotInFlight: Promise<unknown> | undefined
  guard?: PoisonGuard
  importer?: Importer
  pitfalls?: PitfallStore
  skills?: SkillRegistry
  /**
   * 用户画像仓库（带 journal）。
   *
   * 单独挂在 runtime 上而不是每次 `new UserProfileStore(...)`：HTTP 写入必须走
   * **同一个带 journal 的实例**，否则接口改完画像、换机器恢复时却看不到这次修改
   * （journal 里没这条事件，得等下一次整库快照才补上）。
   */
  userProfile?: UserProfileStore
  /**
   * 当前进程里活着的 agent 与会话。
   *
   * 为什么不能只靠 persona_state：`agent/created` 到第一次写记忆之间有一段空窗，
   * 此时人格表里还没有这个 Agent，快照就会漏掉它——设备 B 开机后"少了个人"。
   * 所以会话指针单独记在内存，快照时并进 SnapshotState。
   */
  liveAgents: Map<string, { sessions: Set<string>; lastSeenAt: number }>
  intervalSec: number
}

export const apply = (ctx: unknown, config: SharedConfig): void => {
  // 单点收窄：整个文件只在 `apply` 入口与宿主类型打交道，其余全是 SharedHost。
  // 这样 `@deepseek-ai/cordis` 装没装、装哪个小版本，都不会让插件编译失败。
  const host = ctx as SharedHost
  const root = expandPath(config.repo.path)
  const workspaceId = deriveWorkspaceId(config.repo.workspaceRoot || process.cwd())
  const deviceId = resolveDeviceId(config.repo.deviceId)

  const runtime: Runtime = {
    root,
    workspaceId,
    deviceId,
    booted: false,
    promptCache: new Map(),
    lastSnapshotAt: 0,
    snapshotInFlight: undefined,
    liveAgents: new Map(),
    intervalSec: config.sync.intervalSec,
  }

  const warn = (message: string): void => host.logger?.warn?.(`[shared-memories] ${message}`)

  // ① 闸门先立起来：ready 之前所有写入路径都会被 RestoreBlockedError 挡住。
  const barrier = new RestoreBarrier({
    blockUntilReady: config.restore.blockUntilReady,
    timeoutMs: config.restore.timeoutMs,
    onTransition: (event) => {
      if (event.to === 'degraded') {
        warn(`恢复降级（${event.reason ?? 'unknown'}）：本机记忆进入只读模式`)
      } else if (event.to === 'ready') {
        host.logger?.info?.('[shared-memories] 恢复完成，记忆可读写')
      }
    },
  })

  let intervalTimer: ReturnType<typeof setInterval> | undefined

  /** 关机/退出前的强制快照；多次触发由 `snapshotInFlight` 合并成一次。 */
  const snapshotNow = (trigger: SnapshotTrigger): Promise<unknown> => {
    if (!runtime.snapshots) return Promise.resolve(undefined)
    if (barrier.phase !== 'ready') {
      warn(`恢复未就绪（${barrier.phase}），跳过 ${trigger} 快照`)
      return Promise.resolve(undefined)
    }
    if (runtime.snapshotInFlight) return runtime.snapshotInFlight
    const run = runtime.snapshots
      .snapshot(trigger)
      .then((result) => {
        runtime.lastSnapshotAt = Date.now()
        host.logger?.info?.(
          `[shared-memories] 快照完成 ${result.tag}（${result.manifest.totals.files} 个文件，` +
            `${result.pushed ? '已推送' : `未推送：${result.pushReason ?? 'unknown'}`}）`,
        )
        return result
      })
      .catch((error: unknown) => {
        warn(`快照失败（${trigger}）：${error instanceof Error ? error.message : String(error)}`)
        return undefined
      })
      .finally(() => {
        runtime.snapshotInFlight = undefined
      })
    runtime.snapshotInFlight = run
    return run
  }

  const startIntervalTimer = (): void => {
    if (intervalTimer) return
    intervalTimer = setInterval(() => {
      void snapshotNow('interval')
    }, Math.max(30, runtime.intervalSec) * 1000)
    if (typeof intervalTimer === 'object' && 'unref' in intervalTimer) intervalTimer.unref()
  }

  const boot = async (): Promise<void> => {
    try {
      const db = await openSqliteDriver(join(root, 'memory.db'))
      runtime.db = db
      migrate(db, SCHEMA_VERSION)

      const journal = new Journal({ root, deviceId, onWarn: warn })
      await journal.open()
      runtime.journal = journal
      runtime.tree = new TemporalTree(db, journal, {
        emotionConfidenceGate: config.memory.distill.emotionConfidenceGate,
      })
      runtime.guard = new PoisonGuard({
        db,
        journal,
        trustBySource: config.poison.trustBySource,
        onWarn: warn,
      })

      const git = new ExecGitRunner({ cwd: root, timeoutMs: config.sync.timeoutMs })
      runtime.snapshots = new SnapshotEngine({
        root,
        deviceId,
        git,
        schemaVersion: SCHEMA_VERSION,
        keep: config.snapshot.keep,
        pinProtected: config.snapshot.pinProtected,
        maxBytes: config.snapshot.maxBytes,
        remote: config.repo.remote,
        branch: config.repo.branch,
        pushOnCommit: config.sync.pushOnCommit && !isLocalOnly(config),
        retries: config.sync.retries,
        authorName: config.repo.authorName,
        authorEmail: config.repo.authorEmail,
        onWarn: warn,
        collectState: () => ({ agents: collectAgents(runtime), userProfiles: collectProfiles(runtime) }),
      })

      runtime.restore = new RestoreEngine({
        root,
        db,
        journal,
        barrier,
        git,
        remote: config.repo.remote,
        branch: config.repo.branch,
        pullStrategy: config.sync.pullStrategy,
        offlinePolicy: config.restore.offlinePolicy,
        timeoutMs: config.sync.timeoutMs,
        retries: config.sync.retries,
        onWarn: warn,
        allowMissingSnapshot: true,
      })

      runtime.importer = new Importer({
        tree: runtime.tree,
        guard: runtime.guard,
        db,
        journal,
        onWarn: warn,
      })

      // 踩坑链（observation → lesson → pattern → rule）。升格请求带 TTL 存在内存里，
      // 过期即作废——这是"改 System Prompt 必须当下确认"的实现约束。
      runtime.pitfalls = new PitfallStore({ db, journal, onWarn: warn })

      // 技能注册表带 journal：控制台上的挂载/卸载/开关都会写 `skill.*` 事件，
      // 这样"没来得及打快照就换机"也不会丢技能。
      runtime.skills = new SkillRegistry({ db, journal, clock: () => Date.now(), onWarn: warn })
    runtime.userProfile = new UserProfileStore({ db, journal, clock: () => Date.now(), onWarn: warn })

      const outcome = await runtime.restore.restoreOnBoot()
      runtime.booted = true
      if (outcome.status === 'ready') {
        await refreshPrompt(runtime, config)
        if (config.sync.enabled && config.snapshot.triggers.interval) startIntervalTimer()
      }
    } catch (error) {
      warn(`启动失败：${error instanceof Error ? error.message : String(error)}`)
      // boot 中途失败也必须结算闸门，否则 agent/created 会一直挂着。
      barrier.fail('boot-failed', error)
    }
  }

  // ② 启动恢复 + ③ 全部事件监听，都挂在同一个 effect 里。
  host.effect(() => {
    void boot()

    const disposers: Array<() => void> = []

    // ③-0 控制台 HTTP 接口。webServer 是**可选**服务：宿主没装就静默跳过，
    // 记忆本体（快照/恢复/检索）不依赖它，不能因为面板挂不上就把插件拖死。
    const applyInterval = (seconds: number): void => {
      runtime.intervalSec = seconds
      if (intervalTimer) {
        clearInterval(intervalTimer)
        intervalTimer = undefined
      }
      if (config.sync.enabled && config.snapshot.triggers.interval) startIntervalTimer()
    }

    const apiDeps: MemoriesApiDeps = {
      config,
      barrier,
      workspaceId,
      deviceId,
      db: () => runtime.db,
      snapshots: () => runtime.snapshots,
      restore: () => runtime.restore,
      saveNow: async () => {
        const result = (await snapshotNow('manual')) as { manifest?: { snapshotId: string }; commit?: string } | undefined
        return { snapshotId: result?.manifest?.snapshotId ?? '', commit: result?.commit }
      },
      testConnection: async () => {
        if (!config.repo.remote) {
          return { ok: true, remote: '', latencyMs: 0, detail: '纯本地模式：未绑定远端仓库' }
        }
        const started = Date.now()
        const git = new ExecGitRunner({ cwd: root, timeoutMs: config.sync.timeoutMs })
        const probe = await git.run(['ls-remote', '--heads', 'origin', config.repo.branch])
        const latencyMs = Date.now() - started
        if (probe.code !== 0) {
          return {
            ok: false,
            remote: config.repo.remote,
            latencyMs,
            detail: probe.stderr.trim() || `git ls-remote exit ${probe.code}`,
          }
        }
        const hasBranch = probe.stdout.split('\n').some((line) => line.includes(`refs/heads/${config.repo.branch}`))
        return {
          ok: true,
          remote: config.repo.remote,
          latencyMs,
          detail: hasBranch ? '网络 / 凭据 / 分支权限均正常' : `远端没有分支 ${config.repo.branch}（首次推送会创建）`,
        }
      },
      setIntervalSec: applyInterval,
      pitfalls: () => runtime.pitfalls,
      skills: () => runtime.skills,
    userProfile: () => runtime.userProfile,
      importMemories: async (input) => {
        if (!runtime.importer) throw new Error('记忆库尚未就绪')
        const report = await runtime.importer.import({
          scope: { workspaceId, agentId: input.agentId || 'default', deviceId },
          content: input.content,
          format: input.format,
        })
        return { parsed: report.parsed, written: report.written, quarantined: report.quarantined }
      },
      // 洗白 = 重新开一个版本。走 TemporalTree 而不是自己拼 INSERT，
      // 否则"关闭旧版本 / seq 递增 / 写 journal"这三件事必然漏一件。
      reopenQuarantine: async (input) => {
        if (!runtime.tree) throw new Error('记忆库尚未就绪')
        const opened = await runtime.tree.openVersion({
          scope: { workspaceId, agentId: input.agentId || 'default', deviceId },
          kind: input.kind as Parameters<typeof runtime.tree.openVersion>[0]['kind'],
          subjectKey: input.subjectKey,
          text: input.text,
          emotion: input.emotion ?? undefined,
          // 人工核实过的内容给高信任度：它已经过了一次人眼审查。
          trust: 0.8,
          author: 'user',
        })
        if (opened.deduped) warn(`洗白内容与现有记忆一致，未新增版本：${opened.entity.entity_id}`)
      },
    }

    const webServer = lookupService(host, 'webServer') as WebServerLike | undefined
    if (webServer) {
      disposers.push(registerRoutes(webServer, apiDeps))
    } else {
      warn('宿主没有 webServer 服务，控制台接口未注册（记忆功能不受影响）')
    }

    // ③-1 冷启动闸门：serial 事件，await 之后宿主才放行排队中的输入。
    disposers.push(
      host.on('agent/created', async (...args: unknown[]) => {
        const agentId = readAgentId(args[0])
        // 先登记"这个 Agent 活着"再等闸门：persona_state 里此时可能还没有它
        //（还没写过任何记忆），但快照必须带上，否则换台机器就少一个人。
        trackPresence(runtime, agentId, readSessionId(args[0]))
        if (agentId) ensureAgentRow(runtime, agentId, workspaceId)
        const phase = await barrier.wait()
        if (phase === 'degraded') {
          warn(`记忆只读降级（${barrier.reason ?? 'unknown'}），agent ${agentId || '?'} 以受限模式启动`)
        }
        await refreshPrompt(runtime, config)
        return undefined
      }),
    )

    // ③-2 turn 结束的持久化检查点：先落 journal，再按空闲防抖决定要不要快照。
    disposers.push(
      host.on('session/flush', async () => {
        await runtime.journal?.flush()
        if (!config.sync.enabled || !config.snapshot.triggers.idle) return
        const idleMs = Math.max(5, config.sync.idleDebounceSec) * 1000
        if (Date.now() - runtime.lastSnapshotAt < idleMs) return
        await snapshotNow('idle')
      }),
    )

    // ③-3 agent 释放 = 关机型快照（多 agent 时靠 snapshotInFlight 合并，不放大成 N 次）。
    disposers.push(host.on('agent/disposed', () => void snapshotNow('shutdown')))

    // ③-4 配置热更新：只重建提示词，不做快照（避免把配置抖动写进历史）。
    disposers.push(host.on('app-boot/config-reload', () => void refreshPrompt(runtime, config)))

    // ④ System Prompt 注入：人格 + 已确认规则，order 小 = 靠前 = 优先级高。
    disposers.push(
      host.systemPrompt.section({
        name: 'shared-memories:persona-and-rules',
        order: 5,
        text: (context: unknown) => {
          const agentId = readAgentId(context) || 'default'
          return runtime.promptCache.get(agentId) ?? ''
        },
      }),
    )

    const onSignal = (signal: string): void => {
      host.logger?.info?.(`[shared-memories] 收到 ${signal}，正在落盘快照`)
      void snapshotNow('shutdown')
    }
    const sigint = (): void => onSignal('SIGINT')
    const sigterm = (): void => onSignal('SIGTERM')
    process.once('SIGINT', sigint)
    process.once('SIGTERM', sigterm)

    return () => {
      if (intervalTimer) clearInterval(intervalTimer)
      intervalTimer = undefined
      process.removeListener('SIGINT', sigint)
      process.removeListener('SIGTERM', sigterm)
      for (const dispose of disposers.reverse()) dispose()
      void snapshotNow('shutdown')
      void runtime.journal?.flush()
    }
  })
}

// ── 辅助 ──────────────────────────────────────────────────────────────────

/** `~` 展开；相对路径按 cwd 解析。 */
function expandPath(path: string): string {
  const trimmed = path.trim()
  if (!trimmed) return join(homedir(), '.dsh', 'shared-memories')
  if (trimmed === '~') return homedir()
  if (trimmed.startsWith('~/') || trimmed.startsWith('~\\')) {
    return resolve(homedir(), trimmed.slice(2))
  }
  return resolve(trimmed)
}

/** 设备 id：显式配置优先，否则用主机名消毒后兜底 `local`。 */
function resolveDeviceId(configured: string): string {
  const candidate = (configured || hostname() || DEVICE_ID_FALLBACK)
    .replace(/[^0-9A-Za-z_-]/g, '_')
    .slice(0, 64)
  return candidate.length >= 3 ? candidate : DEVICE_ID_FALLBACK
}

/** 从各种事件负载里挖 agent id（`agent/created` 是 `{agent:{id}}`，Prompt 上下文也是）。 */
function readAgentId(payload: unknown): string {
  if (!payload || typeof payload !== 'object') return ''
  const record = payload as { agent?: { id?: unknown }; agentId?: unknown; id?: unknown }
  const candidate = record.agent?.id ?? record.agentId ?? record.id
  return typeof candidate === 'string' ? candidate : ''
}

/** 会话 id 可能挂在 payload.session / payload.agent.session / payload.sessionId 上。 */
function readSessionId(payload: unknown): string {
  if (!payload || typeof payload !== 'object') return ''
  const record = payload as {
    session?: { id?: unknown }
    sessionId?: unknown
    agent?: { session?: { id?: unknown }; sessionId?: unknown }
  }
  const candidate =
    record.session?.id ?? record.sessionId ?? record.agent?.session?.id ?? record.agent?.sessionId
  return typeof candidate === 'string' ? candidate : ''
}

/** 内存登记：agent → 它开过的会话集合。 */
function trackPresence(runtime: Runtime, agentId: string, sessionId: string): void {
  if (!agentId) return
  const entry = runtime.liveAgents.get(agentId) ?? { sessions: new Set<string>(), lastSeenAt: 0 }
  if (sessionId) entry.sessions.add(sessionId)
  entry.lastSeenAt = Date.now()
  runtime.liveAgents.set(agentId, entry)
}

/**
 * 让 `agent/created` 的 Agent 立刻出现在 persona_state 里。
 *
 * 只插不改：`ON CONFLICT DO NOTHING`——已有的人格（用户改过的名字/年龄/特质）
 * 绝不能被"开机事件"覆盖掉，这是真实数据与"存在性登记"的边界。
 */
function ensureAgentRow(runtime: Runtime, agentId: string, workspaceId: string): void {
  if (!runtime.db) return
  try {
    runtime.db.run(
      `INSERT INTO persona_state (agent_id, workspace_id, name, age, traits, baseline_hash, updated_at)
       VALUES (?,?,?,?,?,?,?)
       ON CONFLICT(agent_id, workspace_id) DO NOTHING`,
      [agentId, workspaceId, agentId, 10, '{}', '', Date.now()],
    )
  } catch {
    /* 人格表还没迁移完：下一轮 agent/created 再补，不阻塞启动 */
  }
}

/**
 * 采集所有已注册 agent 的状态用于快照。
 *
 * 读的是 `persona_state`（人格真相由 journal 回放得来，这里只是物化视图）：
 * 快照必须覆盖**所有** agent，否则"多智能体"就会退化成"只漫游了一个人"。
 */
function collectAgents(runtime: Runtime): SnapshotAgentState[] {
  if (!runtime.db) return []
  try {
    const rows = runtime.db.all<{
      agent_id: string
      workspace_id: string
      name: string
      age: number
      traits: string
      baseline_hash: string
    }>(`SELECT agent_id, workspace_id, name, age, traits, baseline_hash FROM persona_state`)
    const byAgent = new Map<string, { agentId: string; workspaceIds: string[]; persona: Record<string, unknown>; sessions: string[]; skills: SkillBinding[] }>()
    for (const row of rows) {
      const current =
        byAgent.get(row.agent_id) ??
        { agentId: row.agent_id, workspaceIds: [], persona: {}, sessions: [] as string[], skills: [] }
      current.workspaceIds.push(row.workspace_id)
      current.persona = {
        name: row.name,
        age: row.age,
        traits: safeJson(row.traits),
        baselineHash: row.baseline_hash,
        workspaceId: row.workspace_id,
      }
      byAgent.set(row.agent_id, current)
    }
    // 再并上"刚创建、还没写过记忆"的 Agent（内存登记），否则它们不会进快照。
    for (const [agentId, entry] of runtime.liveAgents) {
      const current =
        byAgent.get(agentId) ??
        { agentId, workspaceIds: [], persona: {}, sessions: [] as string[], skills: [] }
      if (!current.workspaceIds.includes(runtime.workspaceId)) {
        current.workspaceIds.push(runtime.workspaceId)
      }
      // 会话指针并集：人格表里存不下"这台机器上开过哪些会话"，只能靠内存登记。
      current.sessions = [...new Set([...current.sessions, ...entry.sessions])]
      byAgent.set(agentId, current)
    }
    // 技能绑定：按 (workspace, agent) 逐个取，绝不跨 Agent 合并。
    // 一个 Agent 可能横跨多个工作区且各挂不同技能，所以是"每个工作区各取一份再并集"。
    for (const current of byAgent.values()) {
      const merged: SkillBinding[] = []
      for (const workspaceId of current.workspaceIds) {
        merged.push(...readSkillBindings(runtime.db, { workspaceId, agentId: current.agentId }))
      }
      current.skills = normalizeBindings(merged)
    }
    return [...byAgent.values()]
  } catch {
    return []
  }
}

/**
 * 用户画像快照采集：整表上行。
 *
 * 画像只有 workspace 维度、体积极小（一个工作区一行），所以不做筛选——
 * 少带一个工作区，就等于那台机器恢复后忘掉一个项目里的称呼。
 */
function collectProfiles(runtime: Runtime): UserProfile[] {
  if (!runtime.db) return []
  try {
    return new UserProfileStore({ db: runtime.db }).all()
  } catch {
    return []
  }
}

/**
 * 重建提示词缓存。
 *
 * 只放"每次对话都值得花钱的"内容：人格摘要 + 已确认规则 + 少量高重要度记忆。
 * 全量记忆绝不进 System Prompt——那是检索引擎的活，塞进提示词只会烧 token。
 */
async function refreshPrompt(runtime: Runtime, config: SharedConfig): Promise<void> {
  if (!runtime.db) return
  let agents: string[] = []
  try {
    agents = runtime.db
      .all<{ agent_id: string }>(`SELECT DISTINCT agent_id FROM persona_state`)
      .map((row) => row.agent_id)
  } catch {
    agents = []
  }
  if (agents.length === 0) agents = ['default']

  for (const agentId of agents) {
    const scope: Scope = {
      workspaceId: runtime.workspaceId,
      agentId,
      deviceId: runtime.deviceId,
    }
    const query = new ScopedQuery(runtime.db, scope, {
      allowGlobalSearch: config.isolation.allowGlobalSearch,
    })

    const persona = runtime.db.one<{ name: string; age: number; traits: string; baseline_hash: string }>(
      `SELECT name, age, traits, baseline_hash FROM persona_state
        WHERE agent_id = ? AND workspace_id = ?`,
      [agentId, runtime.workspaceId],
    )

    const rules = safeHits(query, { kinds: ['pitfall', 'preference', 'persona'], limit: 6 })
    const lines: string[] = []
    lines.push('## 你的记忆与人格（dsh-shared-memories）')
    // 用户画像：**按 workspace 取，与 agent 无关**——换会话、换 Agent 都还是同一个人。
    // 没有画像时不写"用户是 X"，而是写清"不知道，别猜"：留空等于把猜的权力交还模型。
    const profile = safeProfile(runtime, runtime.workspaceId)
    const address = profileAddress(profile)
    if (address !== '') {
      lines.push(`- 你的用户：${address}（称呼就用这个，不要改写成别的人名）`)
    } else {
      lines.push('- 你的用户：名字尚未记录。不要从仓库署名、提交记录或设备名里猜，需要时直接问。')
    }
    lines.push(
      `- 当前智能体：${persona?.name || agentId}`,
    )
    lines.push(`- 工作区：${runtime.workspaceId}`)
    lines.push(`- 底线：${config.persona.baselineNotice}`)
    // 技能段：按 (workspaceId, agentId) 精确取，缺一个条件就会串台。
    const skills = readSkillBindings(runtime.db, scope)
    if (skills.length > 0) {
      lines.push('')
      lines.push('### 这个 Agent 当前挂载的技能')
      for (const skill of skills) {
        const version = skill.version ? ` ${skill.version}` : ''
        lines.push(`- \`${skill.skillId}\`${version}${skill.enabled ? '' : ' · 已停用'}`)
      }
    }
    if (rules.length > 0) {
      lines.push('')
      lines.push('### 已确认的规则与偏好（优先级高于一般记忆）')
      for (const hit of rules) lines.push(`- [${hit.kind}] ${compact(hit.text, 180)}`)
    }
    runtime.promptCache.set(agentId, `${lines.join('\n')}\n`)
  }
}

/** 检索失败不该拖垮对话：拿不到记忆就当没有。 */
function safeProfile(runtime: Runtime, workspaceId: string): UserProfile | undefined {
  if (!runtime.db) return undefined
  try {
    return new UserProfileStore({ db: runtime.db }).get(workspaceId)
  } catch {
    return undefined
  }
}

function safeHits(query: ScopedQuery, options: Parameters<ScopedQuery['search']>[0]): MemoryHit[] {
  try {
    return query.search(options)
  } catch {
    return []
  }
}

function compact(text: string, limit: number): string {
  const oneLine = text.replace(/\s+/g, ' ').trim()
  return oneLine.length <= limit ? oneLine : `${oneLine.slice(0, limit - 1)}…`
}

function safeJson(value: string): unknown {
  try {
    return JSON.parse(value) as unknown
  } catch {
    return {}
  }
}
