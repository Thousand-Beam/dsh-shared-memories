/**
 * dsh-shared-memories — 作用域（Scope）与隔离原语
 * ---------------------------------------------------------------------------
 * PRD 5 要求"数据库查询层必须强制注入 WHERE workspace_id = current_workspace"。
 * 把这件事做对的关键不是"记得加 where"，而是让**没有 scope 就构造不出查询对象**：
 *   - `ScopedQuery` 与 `TemporalTree` 的构造函数都要求 Scope；
 *   - `assertScope()` 在构造期就抛，而不是等到 SQL 拼完才发现。
 *
 * 本文件同时提供 workspace_id 的**确定性推导**：同一项目在不同会话、不同启动
 * 方式下必须得到同一个 id，否则"记忆在但检索不到"会比没有记忆更糟。
 */
import { createHash } from 'node:crypto'
import { realpathSync } from 'node:fs'
import path from 'node:path'

/**
 * 一次操作的作用域。
 * - `workspaceId`：工作区强隔离键，由 `deriveWorkspaceId()` 从真实路径推导。
 * - `agentId`：人格/子代理维度（同一个项目里，主代理与子代理的记忆不互通）。
 * - `deviceId`：写入设备，多端冲突时用于区分"谁写的"。
 */
export interface Scope {
  readonly workspaceId: string
  readonly agentId: string
  readonly deviceId?: string
  /** 本次写入的信任度基线，外部导入的内容应显式给 0.2~0.3。 */
  readonly trust?: number
}

/**
 * 一次性全局检索令牌（PRD 5 的"全局检索开关"）。
 * 不是布尔开关：带 reason / 签发者 / TTL，且必须落审计，防止"顺手全库搜"变成常态。
 */
export interface GlobalToken {
  readonly reason: string
  readonly issuedBy: string
  readonly issuedAt: number
  readonly ttlMs: number
}

/** workspace_id 合法形态：1~128 个安全字符，禁止通配符与空白，杜绝 SQL/LIKE 注入面。 */
const SCOPE_TOKEN = /^[0-9A-Za-z][0-9A-Za-z._:-]{0,127}$/

/**
 * 校验并收窄 Scope。任何入口（查询、写入、导入）都必须先过这里。
 * @param origin 调用点标识，仅用于错误信息，便于定位是哪条路径漏了 scope。
 */
export function assertScope(scope: Scope | undefined | null, origin: string): asserts scope is Scope {
  if (!scope) throw new ScopeViolation('missing-scope', { origin })
  if (!SCOPE_TOKEN.test(scope.workspaceId)) {
    throw new ScopeViolation('invalid-workspace-id', { origin, workspaceId: scope.workspaceId })
  }
  if (!SCOPE_TOKEN.test(scope.agentId)) {
    throw new ScopeViolation('invalid-agent-id', { origin, agentId: scope.agentId })
  }
}

/** 隔离被破坏时抛出的唯一错误类型，便于上层统一转成"拒绝执行"而不是"查了个空"。 */
export class ScopeViolation extends Error {
  readonly code: string
  readonly detail: Record<string, unknown>

  constructor(code: string, detail: Record<string, unknown> = {}) {
    super(`scope violation: ${code}`)
    this.name = 'ScopeViolation'
    this.code = code
    this.detail = detail
  }
}

/**
 * 从工作区根目录推导稳定的 workspace_id。
 *
 * 规则：
 *  1. 先 `realpath`（消除软链接、`..`、大小写差异）；
 *  2. Windows / macOS 默认大小写不敏感 → 统一小写；Linux 保留大小写；
 *  3. 取 sha256 前 16 个 hex 字符：足够避免碰撞，又能直接放进 URL/日志。
 *
 * 失败（路径不存在）时退化为对规范化字符串求哈希，仍然保持确定性，不抛错——
 * 冷启动阶段路径可能还没挂载，此时不能因为推导失败就拒绝整个插件。
 */
export function deriveWorkspaceId(workspaceRoot: string, platform: NodeJS.Platform = process.platform): string {
  let resolved = path.resolve(workspaceRoot)
  try {
    resolved = realpathSync.native(resolved)
  } catch {
    // 路径暂不可达：保留 resolve 后的结果，语义仍是确定的。
  }
  const caseInsensitive = platform === 'win32' || platform === 'darwin'
  const normalized = caseInsensitive ? resolved.toLowerCase() : resolved
  return createHash('sha256').update(normalized, 'utf8').digest('hex').slice(0, 16)
}

/** 转义 LIKE 通配符，避免用户输入的 `%`/`_` 变成"全表扫描"。 */
export function escapeLike(input: string): string {
  return input.replace(/[\\%_]/g, (ch) => `\\${ch}`)
}

/** 全局令牌是否仍在有效期内。 */
export function isGlobalTokenValid(token: GlobalToken | undefined, now = Date.now()): token is GlobalToken {
  if (!token) return false
  if (!token.reason || !token.issuedBy) return false
  if (!Number.isFinite(token.ttlMs) || token.ttlMs <= 0) return false
  return now - token.issuedAt < token.ttlMs
}
