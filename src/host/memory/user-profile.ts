/**
 * 用户画像的持久化。
 *
 * 只有 workspace 维度：读它的时候**不可能**带错 agent_id，这是刻意设计——
 * 记忆卡的每条查询都硬拼 `AND e.agent_id = ?`，那是隔离的根基；
 * 想给"全局画像"开一条绕过 agent 的旁路，等于给串台留门。
 *
 * 每次写入都 journal 一条 `user_profile.set`，payload 带全部字段（不是只记 id），
 * 这样换机器重放 journal 就能重建出完整画像，而不是一个空壳。
 */
import type { SqlDriver } from '../../shared/types.js'
import type { Journal } from '../../shared/journal.js'
import {
  EMPTY_PROFILE,
  normalizeProfileInput,
  type UserProfile,
  type UserProfileInput,
} from '../../shared/user-profile.js'

export interface UserProfileStoreOptions {
  readonly db: SqlDriver
  readonly journal?: Journal
  readonly clock?: () => number
  readonly onWarn?: (message: string) => void
}

interface ProfileRow {
  workspace_id: string
  display_name: string
  preferred_address: string
  notes: string
  updated_at: number
  updated_by: string
}

export class UserProfileStore {
  readonly #db: SqlDriver
  readonly #journal: Journal | undefined
  readonly #clock: () => number
  readonly #onWarn: (message: string) => void

  constructor(options: UserProfileStoreOptions) {
    this.#db = options.db
    this.#journal = options.journal
    this.#clock = options.clock ?? (() => Date.now())
    this.#onWarn = options.onWarn ?? (() => {})
  }

  /** 读画像。没写过返回空画像（而不是 undefined），调用方少一层判空。 */
  get(workspaceId: string): UserProfile {
    const row = this.#db.one<ProfileRow>(
      `SELECT workspace_id, display_name, preferred_address, notes, updated_at, updated_by
         FROM user_profile WHERE workspace_id = ?`,
      [workspaceId],
    )
    if (!row) return { workspaceId, ...EMPTY_PROFILE }
    return {
      workspaceId: row.workspace_id,
      displayName: row.display_name,
      preferredAddress: row.preferred_address,
      notes: row.notes,
      updatedAt: row.updated_at,
      updatedBy: row.updated_by,
    }
  }

  /**
   * 列出全部画像（快照用）。
   *
   * 这里**不按 scope 过滤**是刻意的：画像本来就属于"这个人跨项目的身份"，
   * 而快照是整库快照（记忆、人格、技能都是全量上行）。少存一个工作区，
   * 就等于那台机器恢复后少记一个项目里的称呼。
   */
  all(): UserProfile[] {
    return this.#db
      .all<ProfileRow>(
        `SELECT workspace_id, display_name, preferred_address, notes, updated_at, updated_by
           FROM user_profile ORDER BY workspace_id`,
        [],
      )
      .map((row) => ({
        workspaceId: row.workspace_id,
        displayName: row.display_name,
        preferredAddress: row.preferred_address,
        notes: row.notes,
        updatedAt: row.updated_at,
        updatedBy: row.updated_by,
      }))
  }

  /**
   * 写画像（整条覆盖）。空串表示"清掉这个字段"，
   * 所以把名字改成空就等于回到"别猜，直接问"的兜底状态。
   */
  async save(workspaceId: string, input: UserProfileInput, by = 'user'): Promise<UserProfile> {
    const clean = normalizeProfileInput(input)
    const at = this.#clock()
    this.#db.run(
      `INSERT INTO user_profile (workspace_id, display_name, preferred_address, notes, updated_at, updated_by)
       VALUES (?,?,?,?,?,?)
       ON CONFLICT(workspace_id) DO UPDATE SET
         display_name = excluded.display_name,
         preferred_address = excluded.preferred_address,
         notes = excluded.notes,
         updated_at = excluded.updated_at,
         updated_by = excluded.updated_by`,
      [workspaceId, clean.displayName ?? '', clean.preferredAddress ?? '', clean.notes ?? '', at, by],
    )
    const profile: UserProfile = {
      workspaceId,
      displayName: clean.displayName ?? '',
      preferredAddress: clean.preferredAddress ?? '',
      notes: clean.notes ?? '',
      updatedAt: at,
      updatedBy: by,
    }
    // journal 失败不回滚内存里的写：数据已经在库里，只是这轮不会漫游。
    // 但要让人看见——静默的"不会同步"是最难查的那类问题。
    try {
      await this.#journal?.append({
        op: 'user_profile.set',
        at,
        workspaceId,
        displayName: profile.displayName,
        preferredAddress: profile.preferredAddress,
        notes: profile.notes,
        updatedBy: by,
      })
    } catch (cause) {
      this.#onWarn(`user_profile journal 写入失败：${describe(cause)}`)
    }
    return profile
  }

  /** 恢复时用：直接落库，**不写 journal**（重放自己不能再产生新事件）。 */
  replace(workspaceId: string, input: UserProfileInput, by = 'snapshot'): void {
    const clean = normalizeProfileInput(input)
    this.#db.run(
      `INSERT INTO user_profile (workspace_id, display_name, preferred_address, notes, updated_at, updated_by)
       VALUES (?,?,?,?,?,?)
       ON CONFLICT(workspace_id) DO UPDATE SET
         display_name = excluded.display_name,
         preferred_address = excluded.preferred_address,
         notes = excluded.notes,
         updated_at = excluded.updated_at,
         updated_by = excluded.updated_by`,
      [workspaceId, clean.displayName ?? '', clean.preferredAddress ?? '', clean.notes ?? '', this.#clock(), by],
    )
  }
}

function describe(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause)
}
