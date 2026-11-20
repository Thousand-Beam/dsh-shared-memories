/**
 * dsh-shared-memories — HTTP 路由（客户端控制台的唯一数据入口）
 * ---------------------------------------------------------------------------
 * 所有路由挂在同一个前缀 `/dsh/shared-memories` 下，由 webServer 服务分派。
 *
 * 设计取舍：**只注册一条 prefix 路由，内部按 pathname 二次分派**。
 *   - 好处：客户端 api.ts 的 19 个端点只对应一次 `webServer.register`，装配失败
 *     点只有一个；新增端点不会因为"忘了写 policy"而在装配期炸掉（mneme 的做法
 *     是逐条 exact，好处是每个端点独立声明策略，代价是 40+ 次登记）。
 *   - 代价：鉴权策略是整条前缀级的。这里选 `token-write`——读接口开放（面板要
 *     能读），写接口在配置了 apiToken 时必须带 Bearer。
 *
 * 每个 handler 都只做三件事：解析参数 → 调领域对象 → 包成 `{ok,data}`。
 * 业务判断一律不进这一层，否则测试就得开 HTTP 才能覆盖规则。
 */

import type { IncomingMessage, ServerResponse } from 'node:http'
import type { SqlDriver } from '../../shared/types.js'
import { isSafeScopeToken } from '../../shared/scope.js'
import type { GlobalToken, Scope } from '../../shared/scope.js'
import type { Config as SharedConfig } from '../../config.js'
import type { RestoreBarrier } from '../snapshot/barrier.js'
import type { SnapshotEngine } from '../snapshot/engine.js'
import type { RestoreEngine } from '../snapshot/restore.js'
import type { PitfallRow, PitfallStore, PromotionRequest } from '../memory/pitfall.js'
import type { EmotionAttribution } from '../../shared/types.js'
import { isEmotionLabel } from '../../shared/types.js'
import type { SkillBinding } from '../../shared/skills.js'
import { normalizeSkillId, normalizeSkillVersion } from '../../shared/skills.js'
import { SkillRegistry, countSkills, readSkillBindings } from '../memory/skill-registry.js'
import { UserProfileStore } from '../memory/user-profile.js'
import { PersonaIdentityStore, resolvePersonaId } from '../memory/persona-identity.js'
import { forgetSessionTraces, type SessionPolicyStore } from '../memory/session-policy.js'
import type { DistillJobView } from '../distill/jobs.js'
import type { PurgeResult } from '../memory/purge.js'
import { PurgeError } from '../memory/purge.js'
import type { ChatTurn } from '../distill/chunker.js'
import type { ArchiveMode, SessionPolicyDto } from '../../shared/session-policy.js'
import { toPolicyDto } from '../../shared/session-policy.js'
import { ARCHIVE_MODES, isArchiveMode, normalizePolicyInput } from '../../shared/session-policy.js'
import { profileAddress, type UserProfile } from '../../shared/user-profile.js'
// 值导入：错误映射要靠 instanceof。域错误一旦漏成 500，前端就分不清
// "你参数错了"和"插件炸了"——这两种情况在 UI 上必须长得不一样。
import { RestoreBlockedError, RestoreStateError } from '../snapshot/barrier.js'
import { SnapshotError } from '../snapshot/engine.js'
import { RestoreError } from '../snapshot/restore.js'
import { GitCommandError } from '../snapshot/git.js'
import { PitfallError } from '../memory/pitfall.js'
import { ScopeViolation } from '../../shared/scope.js'
import type {
  AgentSummary,
  ConsoleBootstrap,
  MemoryCard,
  PersonaDoc,
  PromotionPreview,
  QuarantineItem,
  RuleItem,
  RulesBundle,
  RuleStage,
  SnapshotNode,
  SkillBindingDto,
  SkillsBundle,
  UserProfileDto,
  IdentityBundle,
} from '../../shared/console-api.js'

/** webServer 服务的最小面（真实实现由宿主提供）。 */
export interface WebServerLike {
  register(route: {
    kind: 'exact' | 'prefix'
    path: string
    policy: 'open' | 'token' | 'token-write'
    handler: (req: IncomingMessage, res: ServerResponse) => unknown
  }): () => void
}

/**
 * 宿主 connection 服务的最小面。宿主的 webServer.register 会静默忽略 route.policy
 * （实测：dsh-host-webserver 只存 kind/path/handler，从不检查 policy 字段），所以
 * token-write 的鉴权不能靠宿主的 policy 声明，只能由插件自己在 handler 里调宿主的
 * connection.admit 补齐。`requestRejection` 返回 401/403 表示该拒绝，undefined 放行。
 */
export interface ConnectionLike {
  requestRejection?(req: IncomingMessage): number | undefined
}

/** 路由需要的一切，全部用 accessor 传进来——避免和 index.ts 循环引用。 */
export interface MemoriesApiDeps {
  readonly config: SharedConfig
  readonly barrier: RestoreBarrier
  readonly workspaceId: string
  readonly deviceId: string
  db(): SqlDriver | undefined
  snapshots(): SnapshotEngine | undefined
  restore(): RestoreEngine | undefined
  /**
   * 宿主 connection 服务（可选）。宿主的 webServer.register 会静默忽略 route.policy，
   * 所以写接口的鉴权由 dispatch 自己调 connection.requestRejection 补齐；拿不到就
   * 跳过鉴权（headless 等无 webServer 的 profile 本就没有 HTTP 面）。
   */
  readonly connection?: ConnectionLike
  /** 手动保存：走 SnapshotEngine.snapshot('manual')。 */
  saveNow(): Promise<{ snapshotId: string; commit?: string }>
  /** 测试连接：探测网络 / Token / 权限（不落库、不改仓库）。 */
  testConnection(): Promise<{ ok: boolean; remote?: string; latencyMs: number; detail: string }>
  /** 改同步间隔（内存即时生效；持久化由宿主配置写回）。 */
  setIntervalSec(seconds: number): void
  importMemories(input: {
    agentId: string
    format: 'auto' | 'json' | 'markdown'
    content: string
  }): Promise<{ parsed: number; written: number; quarantined: number }>
/** 洗白 = 重新开一个版本（详见 resolveQuarantine 的注释）。 */
  reopenQuarantine?(input: {
    quarantineId: string
    agentId: string
    text: string
    kind: string
    subjectKey: string
    emotion: EmotionAttribution | null
  }): Promise<void>
  /** 忘记一条记忆：关闭活跃版本并置 status='forgotten'（写 journal，可跨设备漫游）。 */
  forgetMemory?(input: { entityId: string; agentId: string }): Promise<{ forgotten: boolean; exists: boolean }>
  /** 修改一条记忆的正文：开新版本，旧版本进时间树（写 journal）。 */
  editMemory?(input: { entityId: string; agentId: string; text: string }): Promise<{ versionId: string }>
  /** 删除一条踩坑记录（物理删除 + 审计，不写 journal）。 */
  deletePitfall?(input: { pitfallId: string; agentId: string }): Promise<{ deleted: boolean }>
  /** 情感纠错：改版本的情感标注，写 version.emotion journal 可跨设备漫游（P1-E）。 */
  fixEmotion?(input: {
    versionId: string
    label: string
    subject?: string | null
    trigger?: string | null
    intensity?: number | null
    agentId?: string
  }): Promise<{ versionId: string; changed: boolean }>
  /** 踩坑库（四段式观察 → 规则），「规则与人格」视图的升格入口。 */
  pitfalls?(): PitfallStore | undefined
  /**
   * 技能注册表（带 journal 的那一个）。
   *
   * 为什么必须由宿主注入而不是路由里自己 new：只有带 journal 的实例才会把
   * `skill.bind` 写进事件日志，技能变更才能在不打快照的情况下也跟着漫游。
   */
  skills?(): SkillRegistry | undefined
  /**
   * 用户画像仓库（带 journal 的那一个）。
   *
   * 和 skills 同理：只有带 journal 的实例才写得进事件日志，
   * 画像才能在不打快照的情况下也随 journal 漫游。
   */
  userProfile?(): UserProfileStore | undefined
  /**
   * 会话 → 人格 绑定表（带 journal 的那一个）。
   *
   * 控制台用它做两件事：①把下拉框里的"人格"和底层 agent_id 对齐（换会话不换人）；
   * ②显示"这个 Agent 由几个会话共用"——这是验证继承是否真的在工作的唯一可见证据。
   */
  identity?(): PersonaIdentityStore | undefined
  /**
   * 会话策略（无痕 + 归档策略）。
   *
   * 必须由宿主注入同一实例：URL 写入策略、宿主在写入前读策略，
   * 两边若不是同一个 store，就会出现"UI 显示无痕、实际还在写记忆"。
   */
  policies?(): SessionPolicyStore | undefined
  /** 非致命告警出口（无痕补删之类"收拾残局"的动静，写不进日志也不该拦住请求）。 */
  onWarn?(message: string): void
  /** 会话列表（控制台选会话用；读不到就返回空，不影响其它视图）。 */
  sessions?(): readonly { sessionId: string; title: string }[]
  /** 启动一次提炼：立即返回 jobId，进度靠轮询。 */
  distill?(input: { sessionId: string; mode: 'incremental' | 'deep' }): { jobId: string }
  /** 按 jobId 查进度；`sessionId` 用于查"该会话最近一次任务"。 */
  distillJob?(input: { jobId?: string; sessionId?: string }): DistillJobView | undefined
  /** 彻底销毁（库 + journal 物理抹除）。 */
  purge?(input: { agentId: string; sessionId?: string }): Promise<PurgeResult>
  /** 读会话全文（提炼用），拿不到返回空数组。 */
  sessionTurns?(sessionId: string): Promise<ChatTurn[]>
}

export const API_PREFIX = '/dsh/shared-memories'

/** 统一登记入口：返回 disposer，交给 ctx.effect 管理生命周期。 */
export function registerRoutes(webServer: WebServerLike, deps: MemoriesApiDeps): () => void {
  return webServer.register({
    kind: 'prefix',
    path: API_PREFIX,
    policy: 'token-write',
    handler: (req, res) => {
      void dispatch(req, res, deps).catch((error: unknown) => {
        sendJson(res, 500, { ok: false, error: { code: 'internal-error', message: describe(error) } })
      })
    },
  })
}

async function dispatch(
  req: IncomingMessage,
  res: ServerResponse,
  deps: MemoriesApiDeps,
): Promise<void> {
  const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`)
  const path = url.pathname.slice(API_PREFIX.length) || '/'
  const method = (req.method ?? 'GET').toUpperCase()

  // P0（评价三）：宿主的 webServer.register 会静默忽略 route.policy（token-write 从不
  // 被检查），所以「彻底销毁」这类破坏性写操作对任何能摸到本机端口的人都是裸奔的。
  // 这里对写操作补一道宿主 connection 鉴权（cookie / API 令牌 / Host-Origin 栅栏）。
  // 读接口保持开放（面板要能读）；connection 拿不到时跳过（无 webServer 的 profile）。
  if (method !== 'GET' && method !== 'HEAD' && typeof deps.connection?.requestRejection === 'function') {
    const rejection = deps.connection.requestRejection(req)
    if (rejection !== undefined) {
      const status = rejection === 403 ? 403 : 401
      return sendJson(res, status, {
        ok: false,
        error: { code: 'unauthorized', message: '需要有效的浏览器会话或 API 令牌' },
      })
    }
  }

  try {
    if (method === 'GET' && path === '/state') return sendJson(res, 200, ok(stateOf(deps)))
    if (method === 'GET' && path === '/memories') return sendJson(res, 200, ok(listMemories(deps, url)))
    if (method === 'GET' && path === '/snapshots') {
      return sendJson(res, 200, ok(await listSnapshots(deps)))
    }
    if (method === 'GET' && path === '/quarantine') {
      return sendJson(res, 200, ok(listQuarantine(deps, url)))
    }
    if (method === 'POST' && path === '/emotion') {
      const body = await readJson(req)
      const fix = deps.fixEmotion
      if (!fix) throw new ApiError('emotion-unavailable', '情感纠错服务尚未就绪', 503)
      deps.barrier.assertWritable('emotion-fix')
      const versionId = reqStr(body, 'versionId')
      const label = str(body.label) ?? ''
      // 标签合法性在路由层拦截：deps.fixEmotion 内部只负责落库，不在 HTTP 层抛域错误。
      if (!isEmotionLabel(label)) throw new ApiError('bad-emotion-label', `非法情感标签：${label}`, 400)
      const result = await fix({
        versionId,
        label,
        subject: str(body.subject) ?? null,
        trigger: str(body.trigger) ?? null,
        intensity: num(body.intensity) ?? null,
        agentId: str(body.agentId) ?? undefined,
      })
      // P1-F：版本不存在时不再假 200，改 404，让前端能区分"改到了"和"改了个寂寞"。
      if (!result.changed) throw new ApiError('not-found', `版本不存在：${versionId}`, 404)
      return sendJson(res, 200, ok(result))
    }
    if (method === 'POST' && path === '/memory/forget') {
      const body = await readJson(req)
      const forget = deps.forgetMemory
      if (!forget) throw new ApiError('forget-unavailable', '记忆删除服务尚未就绪', 503)
      deps.barrier.assertWritable('memory-forget')
      const result = await forget({
        entityId: reqStr(body, 'entityId'),
        agentId: str(body.agentId) ?? 'default',
      })
      // P1-F：entityId 从未存在（id 拼错）→ 404；已 forgotten 的重复删 → 幂等 200 false。
      if (!result.exists) throw new ApiError('memory-not-found', '记忆不存在或不属于当前会话', 404)
      return sendJson(res, 200, ok({ forgotten: result.forgotten }))
    }
    if (method === 'POST' && path === '/memory/edit') {
      const body = await readJson(req)
      const edit = deps.editMemory
      if (!edit) throw new ApiError('edit-unavailable', '记忆编辑服务尚未就绪', 503)
      deps.barrier.assertWritable('memory-edit')
      const result = await edit({
        entityId: reqStr(body, 'entityId'),
        agentId: str(body.agentId) ?? 'default',
        text: reqStr(body, 'text'),
      })
      if (result.versionId === '') throw new ApiError('memory-not-found', '记忆不存在或不属于当前会话', 404)
      return sendJson(res, 200, ok(result))
    }
    // ── 人格与规则（「规则与人格」视图的后端）─────────────────────────────
    if (method === 'GET' && path === '/persona') {
      return sendJson(res, 200, ok(readPersona(deps, url)))
    }
    if (method === 'POST' && path === '/persona') {
      const body = await readJson(req)
      deps.barrier.assertWritable('persona-edit')
      return sendJson(res, 200, ok(writePersona(deps, body)))
    }
    if (method === 'GET' && path === '/skills') {
      return sendJson(res, 200, ok(readSkills(deps, url)))
    }
    if (method === 'POST' && path === '/skills') {
      const body = await readJson(req)
      deps.barrier.assertWritable('skill-edit')
      return sendJson(res, 200, ok(writeSkills(deps, body)))
    }
    if (method === 'GET' && path === '/user-profile') {
      return sendJson(res, 200, ok(readUserProfile(deps)))
    }
    if (method === 'POST' && path === '/user-profile') {
      const body = await readJson(req)
      deps.barrier.assertWritable('user-profile-edit')
      return sendJson(res, 200, ok(await writeUserProfile(deps, body)))
    }
    if (method === 'GET' && path === '/identity') {
      return sendJson(res, 200, ok(readIdentities(deps)))
    }
    if (method === 'POST' && path === '/identity') {
      const body = await readJson(req)
      deps.barrier.assertWritable('identity-edit')
      return sendJson(res, 200, ok(await writeIdentity(deps, body)))
    }
    // ── 会话策略 / 提炼 / 销毁 ─────────────────────────────────────────────
    if (method === 'GET' && path === '/session-policy') {
      const store = deps.policies?.()
      if (!store) throw new ApiError('policies-unavailable', '会话策略尚未就绪', 503)
      const sessionId = url.searchParams.get('sessionId') ?? ''
      if (sessionId === '') throw new ApiError('missing-session', '缺少 sessionId')
      const policy = store.get(sessionId, deps.workspaceId, url.searchParams.get('agentId') ?? '')
      return sendJson(res, 200, ok(toPolicyDto(policy)))
    }
    if (method === 'POST' && path === '/session-policy') {
      const store = deps.policies?.()
      if (!store) throw new ApiError('policies-unavailable', '会话策略尚未就绪', 503)
      const body = await readJson(req)
      const sessionId = reqStr(body, 'sessionId')
      deps.barrier.assertWritable('session-policy')
      const input = normalizePolicyInput({
        ephemeral: body.ephemeral === true ? true : body.ephemeral === false ? false : undefined,
        ...(isArchiveMode(body.archiveMode) ? { archiveMode: body.archiveMode as ArchiveMode } : {}),
      })
      const policy = store.set(sessionId, deps.workspaceId, input, str(body.agentId) ?? '')
      // 无痕是"创建时就定"的，而宿主先发 agent/created、后把 sessionId 交回客户端，
      // 中间那一瞬已经登记过人格。这里补删，让"无痕"在库里真的是零痕迹。
      if (policy.ephemeral) {
        const db = deps.db()
        const removed = db === undefined ? 0 : forgetSessionTraces(db, deps.workspaceId, sessionId)
        if (removed > 0) {
          deps.onWarn?.(`无痕会话 ${sessionId} 创建时残留的 ${removed} 行登记已清除`)
        }
      }
      return sendJson(res, 200, ok(toPolicyDto(policy)))
    }
    if (method === 'GET' && path === '/sessions') {
      return sendJson(res, 200, ok({ items: deps.sessions?.() ?? [] }))
    }
    /**
     * 批量无痕清单：侧栏每一行都要判断"我是不是无痕"，逐行查询会打爆接口。
     * 只返回 id，不返回策略细节——徽标只需要知道"在不在这个集合里"。
     */
    if (method === 'GET' && path === '/session-policies') {
      const store = deps.policies?.()
      if (!store) throw new ApiError('policies-unavailable', '会话策略尚未就绪', 503)
      return sendJson(res, 200, ok({ ephemeral: store.ephemeralSessions(deps.workspaceId) }))
    }
    if (method === 'POST' && path === '/distill') {
      const body = await readJson(req)
      const sessionId = reqStr(body, 'sessionId')
      const mode = isArchiveMode(body.mode) && body.mode !== 'off' ? body.mode : 'incremental'
      const start = deps.distill
      if (!start) throw new ApiError('distill-unavailable', '提炼服务尚未就绪', 503)
      deps.barrier.assertWritable('distill')
      return sendJson(res, 200, ok(start({ sessionId, mode })))
    }
    if (method === 'GET' && path === '/distill/job') {
      const jobId = url.searchParams.get('jobId') ?? ''
      const sessionId = url.searchParams.get('sessionId') ?? ''
      if (jobId === '' && sessionId === '') throw new ApiError('missing-job', '缺少 jobId 或 sessionId')
      const job = deps.distillJob?.({ ...(jobId !== '' ? { jobId } : {}), ...(sessionId !== '' ? { sessionId } : {}) })
      return sendJson(res, 200, ok(job ?? null))
    }
    if (method === 'POST' && path === '/purge') {
      const body = await readJson(req)
      const agentId = reqStr(body, 'agentId')
      const purge = deps.purge
      if (!purge) throw new ApiError('purge-unavailable', '销毁服务尚未就绪', 503)
      if (body.confirm !== true) throw new ApiError('confirm-required', '销毁不可撤销，需要 confirm=true')
      deps.barrier.assertWritable('purge')
      // 会话 id / 人格 id 都会拼进 persona/<id>.json 等文件路径，先过 scope 令牌校验，
      // 拒绝 `../` 之类的路径穿越字符，不让 HTTP 参数变成删到数据目录之外的文件。
      if (!isSafeScopeToken(agentId)) {
        throw new ApiError('invalid-agent-id', '会话 id 含非法字符，拒绝执行', 400)
      }
      const personaId = resolvePersonaIdOf(deps, agentId)
      if (!isSafeScopeToken(personaId)) {
        throw new ApiError('invalid-persona-id', '人格 id 含非法字符，拒绝执行', 400)
      }
      const result = await purge({ agentId: personaId, sessionId: agentId })
      // 会话本体的清理由 purge 内部完成（dropHostSessionTraces 只删会话日志）。
      // 不在这里额外删投影缓存 / workspace.json：那两样是宿主持有状态，插件直接改磁盘
      // 会跟宿主内存态打架，正是 v0.3.4 修的「未分组 + 未命名」幽灵 bug。
      return sendJson(res, 200, ok(result))
    }
    if (method === 'GET' && path === '/rules') {
      return sendJson(res, 200, ok(readRules(deps, url)))
    }
    if (method === 'POST' && path === '/rules/promote') {
      const body = await readJson(req)
      const store = deps.pitfalls?.()
      if (!store) throw new ApiError('pitfalls-unavailable', '踩坑库尚未就绪', 503)
      const scope = scopeOf(deps, str(body.agentId) ?? '')
      const request = store.requestPromotion({
        scope,
        pitfallId: reqStr(body, 'pitfallId'),
        to: (str(body.to) ?? 'pattern') as RuleStage,
        patch: {
          lesson: str(body.lesson),
          pattern: str(body.pattern),
          rule: str(body.rule),
        },
      })
      return sendJson(res, 200, ok(request))
    }
    if (method === 'POST' && path === '/rules/confirm') {
      const body = await readJson(req)
      const store = deps.pitfalls?.()
      if (!store) throw new ApiError('pitfalls-unavailable', '踩坑库尚未就绪', 503)
      deps.barrier.assertWritable('rules-confirm')
      const by = str(body.by) ?? 'user'
      const row = await store.confirm(reqStr(body, 'requestId'), by, scopeOf(deps, str(body.agentId) ?? ''))
      return sendJson(res, 200, ok(row))
    }
    if (method === 'POST' && path === '/rules/reject') {
      const body = await readJson(req)
      const store = deps.pitfalls?.()
      if (!store) throw new ApiError('pitfalls-unavailable', '踩坑库尚未就绪', 503)
      store.reject(reqStr(body, 'requestId'))
      return sendJson(res, 200, ok({ rejected: true }))
    }
    if (method === 'POST' && path === '/rules/delete') {
      const body = await readJson(req)
      const del = deps.deletePitfall
      if (!del) throw new ApiError('delete-unavailable', '踩坑删除服务尚未就绪', 503)
      deps.barrier.assertWritable('rules-delete')
      const result = await del({
        pitfallId: reqStr(body, 'pitfallId'),
        agentId: str(body.agentId) ?? 'default',
      })
      // 物理删除是幂等语义：重复删返回 {deleted:false} 而非报错——物理删掉后行已
      // 不存在，无法（也不应）区分「从未存在」和「已删除」，与 /memory/forget 的
      // 软删（status 字段可区分）不同。调用方靠 deleted:false 即可知道「没删到」。
      return sendJson(res, 200, ok(result))
    }
    if (method === 'POST' && path === '/snapshots/pin') {
      const body = await readJson(req)
      const snapshotId = reqStr(body, 'snapshotId')
      const pinned = body.pinned === true
      await deps.snapshots()?.setPinned(snapshotId, pinned)
      return sendJson(res, 200, ok({ snapshotId, pinned }))
    }
    if (method === 'POST' && path === '/snapshots/rollback') {
      const body = await readJson(req)
      const snapshotId = reqStr(body, 'snapshotId')
      const rolled = await deps.snapshots()?.rollback(snapshotId)
      return sendJson(res, 200, ok({ snapshotId, commit: rolled?.commit ?? '' }))
    }
    if (method === 'POST' && path === '/save') {
      // 恢复没 ready 时不许写：否则快照会把"半恢复"的库当成真身提交上去。
      deps.barrier.assertWritable('manual-snapshot')
      return sendJson(res, 200, ok(await deps.saveNow()))
    }
    if (method === 'POST' && path === '/test-connection') {
      return sendJson(res, 200, ok(await deps.testConnection()))
    }
    if (method === 'POST' && path === '/sync-interval') {
      const body = await readJson(req)
      const seconds = num(body.intervalSec) ?? 0
      if (seconds < 30) throw new ApiError('bad-interval', '同步间隔不能小于 30 秒')
      deps.setIntervalSec(seconds)
      return sendJson(res, 200, ok({ intervalSec: seconds }))
    }
    if (method === 'POST' && path === '/import') {
      const body = await readJson(req)
      const agentId = reqStr(body, 'agentId')
      const format = (str(body.format) ?? 'auto') as 'auto' | 'json' | 'markdown'
      const content = str(body.content) ?? ''
      if (!content.trim()) throw new ApiError('empty-content', '导入内容为空')
      deps.barrier.assertWritable('importer')
      const result = await deps.importMemories({ agentId, format, content })
      return sendJson(res, 200, ok(result))
    }
    if (method === 'POST' && (path === '/quarantine/approve' || path === '/quarantine/destroy')) {
      const body = await readJson(req)
      const quarantineId = reqStr(body, 'quarantineId')
      const by = str(body.by) ?? 'user'
      const approve = path.endsWith('/approve')
      // 隔离区的两个动作都要写库，恢复未就绪时一律拒绝（只读降级模式）。
      deps.barrier.assertWritable(approve ? 'quarantine-approve' : 'quarantine-destroy')
      await resolveQuarantine(deps, quarantineId, approve, by)
      return sendJson(res, 200, ok({ quarantineId }))
    }
    return sendJson(res, 404, { ok: false, error: { code: 'not-found', message: `${method} ${path}` } })
  } catch (error) {
    const mapped = statusOf(error)
    return sendJson(res, mapped.status, { ok: false, error: { code: mapped.code, message: describe(error) } })
  }
}

/**
 * 域错误 → HTTP 状态码。
 *
 * 这一层存在的理由：`RestoreBlockedError` 曾经一路冒到 catch 里被当成 500，
 * 前端只能显示"请求失败"——用户根本不知道"是恢复还没完成，等一下就好"。
 * 状态码是协议的一部分，必须按语义给，不能一律 500。
 */
function statusOf(error: unknown): { status: number; code: string } {
  if (error instanceof ApiError) return { status: error.status, code: error.code }
  // 越界访问一律 403：这既不是参数错，也不是服务端错。
  if (error instanceof ScopeViolation) return { status: 403, code: error.code }
  // 423 Locked：恢复未 ready 时整库只读，"锁着"比"不可用"更准确。
  if (error instanceof RestoreBlockedError) return { status: 423, code: error.code }
  if (error instanceof RestoreStateError) return { status: 409, code: error.code }
  if (error instanceof SnapshotError) {
    return { status: error.code === 'snapshot-not-found' ? 404 : 400, code: error.code }
  }
  if (error instanceof GitCommandError) return { status: 400, code: error.code }
  if (error instanceof RestoreError) return { status: 409, code: error.code }
  if (error instanceof PitfallError) {
    return { status: error.code === 'pitfall-not-found' ? 404 : 400, code: error.code }
  }
  // 销毁只做了一半（文件被占用 / 库只读）：409 而不是 500。
  // 前端据 code 能显示"残留会在下次开机 replay 时清掉，请重跑一次"。
  if (error instanceof PurgeError) return { status: 409, code: error.code }
  return { status: 500, code: 'request-failed' }
}

// ── 各端点实现 ──────────────────────────────────────────────────────────────

function stateOf(deps: MemoriesApiDeps): ConsoleBootstrap {
  return {
    phase: deps.barrier.phase,
    phaseDetail: describeDetail(deps.barrier.detail),
    agents: listAgents(deps),
    activeAgentId: listAgents(deps)[0]?.agentId ?? '',
    snapshotKeep: deps.config.snapshot.keep,
    allowGlobalSearch: deps.config.isolation.allowGlobalSearch,
    workspaceId: deps.workspaceId,
    deviceId: deps.deviceId,
  }
}

/** 下单时"所有 Agent"从 persona_state 出——这样刚注册、还没写过记忆的 Agent 也在。 */
export function listAgents(deps: MemoriesApiDeps): AgentSummary[] {
  const db = deps.db()
  if (!db) return []
  try {
    const rows = db.all<{
      agent_id: string
      workspace_id: string
      name: string
      age: number
      traits: string
      memory_count: number
    }>(
      // 排序：记忆多的排前面。控制台默认选第一个，所以要选"真的在用的那个人格"，
      // 而不是按 id 字典序第一个（旧实现会让某个空壳会话抢走默认选中）。
      `SELECT p.agent_id, p.workspace_id, p.name, p.age, p.traits,
              (SELECT COUNT(*) FROM memory_entity e
                WHERE e.workspace_id = p.workspace_id AND e.agent_id = p.agent_id) AS memory_count
         FROM persona_state p
        WHERE p.workspace_id = ?
        ORDER BY memory_count DESC, p.agent_id`,
      [deps.workspaceId],
    )
    const identities = deps.identity?.()
    // 过滤掉"历史遗留的空壳会话行"：既没名字、又没记忆、也不是任何绑定的人格。
    // 不过滤的话，下拉框里会一直挂着一串 uuid（真机反馈的原话是"满屏幕的代号"）。
    const personaIds = new Set((identities?.all() ?? []).map((identity) => identity.personaId))
    return rows
      .filter((row) => {
        const memoryCount = Number(row.memory_count ?? 0)
        const named = row.name.trim() !== ''
        if (named || memoryCount > 0) return true
        return personaIds.size === 0 ? true : personaIds.has(row.agent_id)
      })
      .map((row) => ({
      agentId: row.agent_id,
      workspaceId: row.workspace_id,
      // 名字缺省时不要回退成 agent_id：那是一串 session uuid，用户看不懂。
      name: row.name || '',
      age: row.age,
      traits: parseTraits(row.traits),
      // 只要数量，不要清单：总览页要显示"挂了几个技能"，但跨 Agent 的清单本身
      // 就是信息泄漏（能看到别人装了什么），所以这里不给。
      skillCount: countSkills(db, { workspaceId: row.workspace_id, agentId: row.agent_id }),
      memoryCount: Number(row.memory_count ?? 0),
      // 这个人格底下挂了几个会话（≥2 说明"换会话会继承"正在工作）。
      sessionCount: identities ? Math.max(1, identities.sessionsOf(row.agent_id).length) : 1,
    }))
  } catch {
    return []
  }
}

/**
 * 记忆列表。
 *
 * 注意这里的 `global` 处理：UI 上的"全局检索"开关不等于授权。只要用户打开它，
 * 服务端就签发一张短期 GlobalToken（带 reason/issuedBy/ttl），交给 ScopedQuery
 * 校验——这样"绕过隔离"永远是一次被记录的、有过期时间的动作，不是一个布尔位。
 */
function listMemories(deps: MemoriesApiDeps, url: URL): MemoryCard[] {
  const db = deps.db()
  if (!db) return []
  const rawAgentId = url.searchParams.get('agentId') ?? ''
  // P1-D：这里必须和 forget/edit/import 一样把会话 id 解析成人格 id。
  // 记忆是写在 personaId 下的（写路径 scope.agentId = personaId），列表却拿原始
  // 会话 id 直接查，前端换会话后传新 id 就"列表 0 条"——同一批数据删除/编辑能
  // 命中、列表却看不见。resolvePersonaId 是纯查询（查不到返回原值），不写库。
  const agentId = rawAgentId ? resolvePersonaId(db, rawAgentId) : ''
  const query = url.searchParams.get('q') ?? ''
  const kinds = (url.searchParams.get('kinds') ?? '').split(',').filter(Boolean)
  const emotions = (url.searchParams.get('emotions') ?? '').split(',').filter(Boolean)
  const trustMin = Number(url.searchParams.get('trustMin') ?? '0')
  const limit = Number(url.searchParams.get('limit') ?? '60')
  const wantGlobal = url.searchParams.get('global') === '1'
  const now = Date.now()

  const global: GlobalToken | undefined =
    wantGlobal && deps.config.isolation.allowGlobalSearch
      ? {
          reason: 'console-global-search',
          issuedBy: 'console',
          issuedAt: now,
          ttlMs: deps.config.isolation.globalSearchTtlMs,
        }
      : undefined

  const rows = queryMemories(db, {
    workspaceId: deps.workspaceId,
    agentId,
    text: query,
    kinds,
    limit: Number.isFinite(limit) ? limit : 60,
  })
  // 全局检索这次真的被用上了就把令牌里的理由写进审计：越界访问必须留痕。
  if (global) {
    db.run(
      `INSERT INTO audit_log (audit_id, workspace_id, agent_id, action, detail, created_at)
       VALUES (?,?,?,?,?,?)`,
      [`aud_${now.toString(36)}`, deps.workspaceId, agentId, 'memory.global-search', global.reason, now],
    )
  }
  return rows
    .filter((row) => row.trust >= (Number.isFinite(trustMin) ? trustMin : 0))
    .filter((row) => (emotions.length === 0 ? true : emotions.includes(row.emotion?.label ?? 'neutral')))
}

/** 直接 SQL：控制台要的是"这个 Agent 的全部卡片"，不是 top-K 语义检索。 */
function queryMemories(
  db: SqlDriver,
  input: { workspaceId: string; agentId: string; text: string; kinds: string[]; limit: number },
): MemoryCard[] {
  const clauses = [`e.workspace_id = ?`, `v.valid_until IS NULL`, `e.status IN ('active','quarantined')`]
  const params: unknown[] = [input.workspaceId]
  if (input.agentId) {
    clauses.push(`e.agent_id = ?`)
    params.push(input.agentId)
  }
  if (input.kinds.length > 0) {
    clauses.push(`e.kind IN (${input.kinds.map(() => '?').join(',')})`)
    params.push(...input.kinds)
  }
  if (input.text.trim()) {
    clauses.push(`v.text LIKE ? ESCAPE '\\'`)
    params.push(`%${input.text.trim().replace(/[%_\\]/g, (match) => `\\${match}`)}%`)
  }
  params.push(input.limit)
  const rows = db.all<{
    entity_id: string
    version_id: string
    kind: string
    subject_key: string
    text: string
    workspace_id: string
    agent_id: string
    trust: number
    salience: number
    status: string
    distill_status: string
    valid_from: number
    emo_label: string | null
    emo_subject: string | null
    emo_trigger: string | null
    emo_intensity: number | null
  }>(
    `SELECT e.entity_id, v.version_id, e.kind, e.subject_key, v.text,
            e.workspace_id, e.agent_id, e.trust, e.salience, e.status,
            v.distill_status, v.valid_from,
            v.emo_label, v.emo_subject, v.emo_trigger, v.emo_intensity
       FROM memory_entity e JOIN memory_version v ON v.entity_id = e.entity_id
      WHERE ${clauses.join(' AND ')}
      ORDER BY v.valid_from DESC
      LIMIT ?`,
    params,
  )
  return rows.map((row) => ({
    entityId: row.entity_id,
    versionId: row.version_id,
    kind: row.kind,
    subjectKey: row.subject_key,
    text: row.text,
    workspaceId: row.workspace_id,
    agentId: row.agent_id,
    trust: row.trust,
    salience: row.salience,
    status: row.status as MemoryCard['status'],
    distillStatus: row.distill_status as MemoryCard['distillStatus'],
    validFrom: row.valid_from,
    emotion: row.emo_label
      ? {
          label: row.emo_label,
          subject: row.emo_subject ?? '',
          trigger: row.emo_trigger ?? '',
          intensity: row.emo_intensity ?? 0,
        }
      : null,
  }))
}

async function listSnapshots(deps: MemoriesApiDeps): Promise<SnapshotNode[]> {
  const engine = deps.snapshots()
  if (!engine) return []
  const history = await engine.history()
  return history.map((entry) => ({
    snapshotId: entry.snapshotId,
    createdAt: entry.createdAt,
    device: entry.device,
    trigger: entry.trigger,
    commit: entry.commit,
    tag: `snap/${entry.snapshotId}`,
    pinned: entry.pinned,
    summary: entry.summary,
    files: entry.files,
    bytes: entry.bytes,
  }))
}

function listQuarantine(deps: MemoriesApiDeps, url: URL): QuarantineItem[] {
  const db = deps.db()
  if (!db) return []
  const agentId = url.searchParams.get('agentId') ?? ''
  const clauses = [`workspace_id = ?`, `status = 'pending'`]
  const params: unknown[] = [deps.workspaceId]
  if (agentId) {
    clauses.push(`agent_id = ?`)
    params.push(agentId)
  }
  try {
    return db
      .all<{
        quarantine_id: string
        reason: string
        score: number
        payload: string
        created_at: number
      }>(
        `SELECT quarantine_id, reason, score, payload, created_at FROM quarantine
          WHERE ${clauses.join(' AND ')} ORDER BY created_at DESC LIMIT 200`,
        params,
      )
      .map((row) => ({
        quarantineId: row.quarantine_id,
        reason: row.reason,
        score: row.score,
        payload: row.payload,
        createdAt: row.created_at,
      }))
  } catch {
    return []
  }
}

/**
 * 隔离区裁决。
 * 关键事实：被拦下的内容**从未写入时间树**（PoisonGuard 在写入前就 return 了），
 * 所以 quarantine 表里没有 entity_id——"销毁"只是把状态改掉，"洗白"必须重新
 * 走一次 TemporalTree.openVersion 才算真的进了记忆。审批人写 audit_log，
 * 不去污染隔离表结构。
 */
async function resolveQuarantine(
  deps: MemoriesApiDeps,
  quarantineId: string,
  approve: boolean,
  by: string,
): Promise<void> {
  const db = deps.db()
  if (!db) throw new ApiError('not-ready', '记忆库尚未就绪', 503)
  const row = db.one<{ payload: string; agent_id: string }>(
    `SELECT payload, agent_id FROM quarantine WHERE quarantine_id = ?`,
    [quarantineId],
  )
  if (!row) throw new ApiError('not-found', `隔离条目不存在：${quarantineId}`, 404)

  const payload = parseQuarantinePayload(row.payload)
  const reopen = deps.reopenQuarantine
  const now = Date.now()

  // 先校验、后改状态：否则洗白失败会留下一条"已批准但没进记忆"的幽灵记录。
  if (approve) {
    if (!reopen) {
      throw new ApiError('reopen-unavailable', '当前装配未提供洗白写回能力，可改用「导入记忆」手动迁移', 503)
    }
    if (!payload.text.trim()) {
      throw new ApiError('payload-empty', '该隔离条目没有可洗白的内容', 422)
    }
  }

  db.run(`UPDATE quarantine SET status = ? WHERE quarantine_id = ?`, [
    approve ? 'approved' : 'destroyed',
    quarantineId,
  ])
  db.run(
    `INSERT INTO audit_log (audit_id, workspace_id, agent_id, action, detail, created_at)
     VALUES (?,?,?,?,?,?)`,
    [
      `aud_${now.toString(36)}`,
      deps.workspaceId,
      row.agent_id,
      approve ? 'quarantine.approve' : 'quarantine.destroy',
      `${quarantineId} by ${by}`,
      now,
    ],
  )

  if (!approve || !reopen) return
  await reopen({
    quarantineId,
    agentId: row.agent_id,
    text: payload.text,
    kind: payload.kind,
    subjectKey: payload.subjectKey || `quarantine:${quarantineId}`,
    emotion: payload.emotion,
  })
}

interface QuarantinePayload {
  text: string
  kind: string
  subjectKey: string
  emotion: EmotionAttribution | null
}

/** 容错解析：隔离表本来就是"坏数据"的收容所，读它时不能再假设结构一定对。 */
function parseQuarantinePayload(raw: string): QuarantinePayload {
  let value: unknown
  try {
    value = JSON.parse(raw)
  } catch {
    return { text: raw, kind: 'fact', subjectKey: '', emotion: null }
  }
  const record = (value ?? {}) as Record<string, unknown>
  const emotionRaw = record.emotion as Record<string, unknown> | null | undefined
  const emotion: EmotionAttribution | null =
    emotionRaw && isEmotionLabel(emotionRaw.label)
      ? {
          subject: typeof emotionRaw.subject === 'string' ? emotionRaw.subject : '',
          trigger: typeof emotionRaw.trigger === 'string' ? emotionRaw.trigger : '',
          label: emotionRaw.label,
          intensity: typeof emotionRaw.intensity === 'number' ? emotionRaw.intensity : 0.5,
          // confidence 恒为 0：用户点的是"这段文字可以放进来"，不是"这个情感标签是对的"。
          // 置信度为 0 会被时间树的情感闸门整块丢弃——这正是我们想要的：
          // 洗白的是事实，不是模型对事实的情绪判断。
          confidence: 0,
        }
      : null
  return {
    text: typeof record.text === 'string' ? record.text : '',
    kind: typeof record.kind === 'string' ? record.kind : 'fact',
    subjectKey: typeof record.subjectKey === 'string' ? record.subjectKey : '',
    emotion,
  }
}

// ── 小工具 ──────────────────────────────────────────────────────────────────

class ApiError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly status = 400,
  ) {
    super(message)
    this.name = 'ApiError'
  }
}

function ok(data: unknown): { ok: true; data: unknown } {
  return { ok: true, data }
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  if (res.headersSent) return
  const text = JSON.stringify(body)
  res.statusCode = status
  res.setHeader('content-type', 'application/json; charset=utf-8')
  res.setHeader('cache-control', 'no-store')
  res.end(text)
}

async function readJson(req: IncomingMessage): Promise<Record<string, unknown>> {
  const text = await readBody(req)
  if (!text.trim()) return {}
  try {
    const parsed = JSON.parse(text) as unknown
    return parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : {}
  } catch {
    throw new ApiError('bad-json', '请求体不是合法 JSON')
  }
}

function readBody(req: IncomingMessage, cap = 2 * 1024 * 1024): Promise<string> {
  return new Promise((resolve, reject) => {
    let body = ''
    let bytes = 0
    let settled = false
    req.on('data', (chunk: Buffer) => {
      if (settled) return
      bytes += chunk.length
      if (bytes > cap) {
        // 超限直接拒绝而不是截断：半截 JSON 比明确报错更危险。
        // 不要在这里 req.destroy()——那会在 413 响应写出去之前掐断 socket，
        // 客户端只会看到 ECONNRESET 而非明确的 413。让 reject 的 ApiError 向上
        // 传播，由 dispatch 统一 sendError(413)，随后连接自然结束。
        settled = true
        reject(new ApiError('body-too-large', `请求体超过 ${cap} 字节`, 413))
        return
      }
      body += chunk.toString('utf8')
    })
    req.on('end', () => {
      if (!settled) resolve(body)
    })
    req.on('error', (error) => {
      if (!settled) {
        settled = true
        reject(error)
      }
    })
  })
}

function reqStr(body: Record<string, unknown>, key: string): string {
  const value = str(body[key])
  if (!value) throw new ApiError('missing-field', `缺少字段：${key}`)
  return value
}

function str(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined
}

function num(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

/**
 * 把 `barrier.detail`（类型是 `unknown`，因为每个阶段塞进去的东西都不一样：
 * 拉取失败塞 GitResult、重放失败塞记录条数）转成给人看的一行字。
 *
 * 直接 `String(detail)` 会得到 `[object Object]`——这正是状态横幅最不该出现的东西。
 */
function describeDetail(detail: unknown): string {
  if (detail === undefined || detail === null) return ''
  if (typeof detail === 'string') return detail
  if (typeof detail === 'number' || typeof detail === 'boolean') return String(detail)
  if (detail instanceof Error) return detail.message
  try {
    const text = JSON.stringify(detail)
    return text && text !== '{}' ? text : ''
  } catch {
    return ''
  }
}

function parseTraits(raw: string): Record<string, number> {
  try {
    const parsed = JSON.parse(raw) as unknown
    if (!parsed || typeof parsed !== 'object') return {}
    const out: Record<string, number> = {}
    for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
      if (typeof value === 'number' && Number.isFinite(value)) out[key] = value
    }
    return out
  } catch {
    return {}
  }
}

/**
 * 控制台里所有写请求的作用域：workspace 恒定，agent 由调用方指定。
 *
 * 这里必须过一次 `resolvePersonaId`：界面上传下来的是**人格 id**（下拉框里那份），
 * 但历史数据也可能是某个具体会话 id。解析是幂等的——人格 id 解析回自己。
 * 少了这一步，前端换会话后传新 id，后端就查不到旧记忆（真机表现："列表 0 条"）。
 */
function resolvePersonaIdOf(deps: MemoriesApiDeps, agentId: string): string {
  const raw = agentId || 'default'
  const db = deps.db()
  return db ? resolvePersonaId(db, raw) : raw
}

function scopeOf(deps: MemoriesApiDeps, agentId: string): Scope {
  const raw = agentId || 'default'
  const db = deps.db()
  const resolved = db ? resolvePersonaId(db, raw) : raw
  return { workspaceId: deps.workspaceId, agentId: resolved, deviceId: deps.deviceId }
}

/**
 * 身份绑定总览：哪个人格下面挂了哪些会话。
 *
 * 这是"换会话会不会继承"唯一能被看见的证据——界面不做这层展示，
 * 用户就只能靠"它还记得我吗"这种体感去猜。
 */
function readIdentities(deps: MemoriesApiDeps): IdentityBundle {
  const db = deps.db()
  const empty: IdentityBundle = { workspaceId: deps.workspaceId, personas: [], sessions: [] }
  if (!db) return empty
  const store = deps.identity?.() ?? new PersonaIdentityStore({ db })
  try {
    return {
      workspaceId: deps.workspaceId,
      personas: store.personas(deps.workspaceId).map((persona) => ({
        personaId: persona.personaId,
        sessionCount: persona.sessionCount,
        lastSeenAt: persona.lastSeenAt,
      })),
      sessions: store
        .all()
        .filter((identity) => identity.workspaceId === deps.workspaceId)
        .map((identity) => ({
          agentId: identity.agentId,
          personaId: identity.personaId,
          boundAt: identity.boundAt,
          lastSeenAt: identity.lastSeenAt,
        })),
    }
  } catch {
    return empty
  }
}

/**
 * 改绑一个会话。
 *
 * - `bind`：把这个会话挂到指定人格下（"它不是新人，接着上一个人格继续"）；
 * - `split`：反过来，让它成为独立人格（用户明确想并行两个不同人设时用）。
 *
 * 两个动作都写 journal：绑定关系本身也是一种需要漫游的状态。
 */
async function writeIdentity(deps: MemoriesApiDeps, body: Record<string, unknown>): Promise<IdentityBundle> {
  const db = deps.db()
  if (!db) throw new ApiError('db-unavailable', '记忆库尚未就绪', 503)
  const store = deps.identity?.() ?? new PersonaIdentityStore({ db })
  const agentId = reqStr(body, 'agentId')
  const action = str(body.action) ?? 'bind'
  if (action === 'split') {
    await store.bindTo(agentId, deps.workspaceId, agentId, 'user')
  } else {
    const personaId = str(body.personaId) || store.resolve(agentId)
    await store.bindTo(agentId, deps.workspaceId, personaId, 'user')
  }
  return readIdentities(deps)
}

function readUserProfile(deps: MemoriesApiDeps): UserProfileDto {  const store = deps.userProfile?.() ?? (deps.db() ? new UserProfileStore({ db: deps.db() as SqlDriver }) : undefined)
  if (!store) {
    return { workspaceId: deps.workspaceId, displayName: '', preferredAddress: '', address: '', notes: '', updatedAt: 0, updatedBy: '' }
  }
  return toProfileDto(store.get(deps.workspaceId))
}

function toProfileDto(profile: UserProfile): UserProfileDto {
  return {
    workspaceId: profile.workspaceId,
    displayName: profile.displayName,
    preferredAddress: profile.preferredAddress,
    address: profileAddress(profile),
    notes: profile.notes,
    updatedAt: profile.updatedAt,
    updatedBy: profile.updatedBy,
  }
}

/**
 * 写用户画像。
 *
 * 写审计是硬要求：名字被人改掉而没有人知道，是这个插件里最难查的一类事故
 * ——模型会立刻开始用新名字称呼用户，而界面上的"人"没有任何变化。
 */
async function writeUserProfile(
  deps: MemoriesApiDeps,
  body: Record<string, unknown>,
): Promise<UserProfileDto> {
  const db = deps.db()
  if (!db) throw new ApiError('not-ready', '记忆库尚未就绪', 503)
  const store = deps.userProfile?.() ?? new UserProfileStore({ db })
  const by = str(body.by) ?? 'user'
  const profile = await store.save(
    deps.workspaceId,
    {
      displayName: str(body.displayName) ?? '',
      preferredAddress: str(body.preferredAddress) ?? '',
      notes: str(body.notes) ?? '',
    },
    by,
  )
  try {
    db.run(
      `INSERT INTO audit_log (audit_id, workspace_id, agent_id, action, detail, created_at)
       VALUES (?,?,?,?,?,?)`,
      [
        `aud_${Date.now().toString(36)}`,
        deps.workspaceId,
        '',
        'user-profile.update',
        JSON.stringify({ address: profileAddress(profile), by }),
        Date.now(),
      ],
    )
  } catch {
    // 审计失败不回滚画像：画像是"用户自己填的"，不该因为写日志失败就丢掉。
  }
  return toProfileDto(profile)
}

function readSkills(deps: MemoriesApiDeps, url: URL): SkillsBundle {
  const agentId = url.searchParams.get('agentId') ?? 'default'
  const db = deps.db()
  const empty: SkillsBundle = { agentId, workspaceId: deps.workspaceId, items: [] }
  if (!db) return empty
  const scope = scopeOf(deps, agentId)
  return { agentId, workspaceId: deps.workspaceId, items: toSkillDtos(readSkillBindings(db, scope)) }
}

/** 内→外：剥掉 config，版本缺省补空串（DTO 里不用可选字段，前端少一个分支）。 */
function toSkillDtos(bindings: readonly SkillBinding[]): SkillBindingDto[] {
  return bindings.map((skill) => ({
    skillId: skill.skillId,
    version: skill.version ?? '',
    enabled: skill.enabled,
    grantedBy: skill.grantedBy ?? 'user',
    updatedAt: skill.updatedAt ?? 0,
  }))
}

/**
 * 改技能绑定：`action = 'bind' | 'unbind' | 'toggle'`。
 *
 * 三种动作共用一条路由，因为它们都只动 `agent_skill` 的一行或几行，且都要过
 * `assertWritable`（恢复中禁止写）。skillId 在入口就规范化，非法 id 直接 400 ——
 * 技能名是要进 System Prompt 的，不能让它变成提示词注入的入口。
 */
function writeSkills(deps: MemoriesApiDeps, body: Record<string, unknown>): SkillsBundle {
  const db = deps.db()
  if (!db) throw new ApiError('db-unavailable', '记忆库尚未就绪', 503)
  const agentId = str(body.agentId) ?? 'default'
  const scope = scopeOf(deps, agentId)
  const registry =
    deps.skills?.() ??
    new SkillRegistry({
      db,
      onWarn: () => {
        /* 写日志失败不该拦住用户的编辑 */
      },
    })
  const action = str(body.action) ?? 'bind'
  const skillId = normalizeSkillId(str(body.skillId))
  if (skillId === '') {
    throw new ApiError('bad-skill-id', '技能 id 只能是 1-64 位的字母、数字、点、下划线或连字符', 400)
  }
  if (action === 'unbind') {
    registry.unbind(scope, skillId)
  } else if (action === 'toggle') {
    const enabled = body.enabled !== false
    registry.setEnabled(scope, skillId, enabled)
  } else {
    registry.bind(scope, {
      skillId,
      version: normalizeSkillVersion(str(body.version)),
      enabled: body.enabled !== false,
      config: plainObject(body.config),
    })
  }
  return {
    agentId,
    workspaceId: deps.workspaceId,
    items: toSkillDtos(readSkillBindings(db, scope)),
  }
}

/** 只接受纯对象当技能参数；`null`/数组/字符串一律当没传。 */
function plainObject(value: unknown): Record<string, unknown> | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined
  return value as Record<string, unknown>
}

/**
 * 读人格。`baseline_hash` 一起返回，是为了让 UI 能显示那把"锁"：
 * 哈希变了 = 底线声明被改过，控制台必须弹强确认，而不是静默接受。
 */
function readPersona(deps: MemoriesApiDeps, url: URL): PersonaDoc {
  const rawAgentId = url.searchParams.get('agentId') ?? 'default'
  const db = deps.db()
  // P1-D：persona_state.agent_id 存的是**人格 id**（不是会话 id），这里同样要过
  // 一遍 resolvePersonaId，否则前端传会话 id 时查不到已写的人格、凭空返回默认值。
  const agentId = db ? resolvePersonaId(db, rawAgentId) : rawAgentId
  const empty: PersonaDoc = {
    agentId,
    workspaceId: deps.workspaceId,
    name: agentId,
    age: 10,
    traits: {},
    baselineHash: '',
    updatedAt: 0,
  }
  if (!db) return empty
  const row = db.one<{
    name: string
    age: number
    traits: string
    baseline_hash: string
    updated_at: number
  }>(
    `SELECT name, age, traits, baseline_hash, updated_at FROM persona_state
      WHERE agent_id = ? AND workspace_id = ?`,
    [agentId, deps.workspaceId],
  )
  if (!row) {
    // P1-D：明确指定了不存在的 id 时返回 404，不凭空造一个"默认人格"。
    // `default` 是"用户还没写过人格"的合法初态，仍返回空文档让 UI 有初值。
    if (rawAgentId !== 'default') throw new ApiError('persona-not-found', `人格不存在：${rawAgentId}`, 404)
    return empty
  }
  return {
    agentId,
    workspaceId: deps.workspaceId,
    name: row.name || agentId,
    age: row.age,
    traits: parseTraits(row.traits),
    baselineHash: row.baseline_hash,
    updatedAt: row.updated_at,
  }
}

/**
 * 写人格。**这是用户手改，不是特质微移**，所以不做 ±traitShiftMax 夹取——
 * 那个夹取是给"对话中自然漂移"用的；人手输入 0.8 就是 0.8。
 * 但仍然夹在 0..1，避免 UI 送进来 -3 这种脏数据。
 */
function writePersona(deps: MemoriesApiDeps, body: Record<string, unknown>): PersonaDoc {
  const db = deps.db()
  if (!db) throw new ApiError('not-ready', '记忆库尚未就绪', 503)
  const rawAgentId = str(body.agentId) ?? 'default'
  // P1-D：与 readPersona 对称，同样把会话 id 解析成人格 id 再写，否则前端传
  // 会话 id 时会在 persona_state 里另起一行（跟 ensureAgentRow 写的人格 id 对不上）。
  const agentId = resolvePersonaId(db, rawAgentId)
  const name = (str(body.name) ?? agentId).slice(0, 40)
  const age = Math.min(999, Math.max(1, Math.round(num(body.age) ?? 10)))
  const traits: Record<string, number> = {}
  for (const [key, value] of Object.entries(parseTraitsInput(body.traits))) {
    traits[key.slice(0, 32)] = Math.min(1, Math.max(0, value))
  }
  const baselineHash = str(body.baselineHash) ?? ''
  const now = Date.now()
  db.run(
    `INSERT INTO persona_state (agent_id, workspace_id, name, age, traits, baseline_hash, updated_at)
     VALUES (?,?,?,?,?,?,?)
     ON CONFLICT(agent_id, workspace_id) DO UPDATE SET
       name = excluded.name, age = excluded.age, traits = excluded.traits,
       baseline_hash = excluded.baseline_hash, updated_at = excluded.updated_at`,
    [agentId, deps.workspaceId, name, age, JSON.stringify(traits), baselineHash, now],
  )
  db.run(
    `INSERT INTO audit_log (audit_id, workspace_id, agent_id, action, detail, created_at)
     VALUES (?,?,?,?,?,?)`,
    [
      `aud_${now.toString(36)}`,
      deps.workspaceId,
      agentId,
      'persona.edit',
      JSON.stringify({ name, age, traits, baselineHash }),
      now,
    ],
  )
  return { agentId, workspaceId: deps.workspaceId, name, age, traits, baselineHash, updatedAt: now }
}

function parseTraitsInput(value: unknown): Record<string, number> {
  if (!value || typeof value !== 'object') return {}
  const out: Record<string, number> = {}
  for (const [key, raw] of Object.entries(value as Record<string, unknown>)) {
    if (typeof raw === 'number' && Number.isFinite(raw)) out[key] = raw
  }
  return out
}

/** 规则视图：已收敛的踩坑链 + 待人工确认的升格请求（转成前端 DTO）。 */
function readRules(deps: MemoriesApiDeps, url: URL): RulesBundle {
  const agentId = url.searchParams.get('agentId') ?? 'default'
  const store = deps.pitfalls?.()
  if (!store) return { items: [], pending: [] }
  try {
    const scope = scopeOf(deps, agentId)
    return {
      items: store.list(scope, 100).map(toRuleItem),
      pending: store.pending().map(toPromotionPreview),
    }
  } catch {
    return { items: [], pending: [] }
  }
}

function toRuleItem(row: PitfallRow): RuleItem {
  return {
    pitfallId: row.pitfall_id,
    observation: row.observation,
    lesson: row.lesson,
    pattern: row.pattern,
    rule: row.rule,
    stage: row.stage,
    confirmed: row.confirmed === 1,
    occurrences: row.occurrences,
    updatedAt: row.updated_at,
  }
}

function toPromotionPreview(request: PromotionRequest): PromotionPreview {
  return {
    requestId: request.requestId,
    pitfallId: request.pitfallId,
    to: request.to,
    preview: request.preview,
    expiresAt: request.expiresAt,
  }
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
