/**
 * 用户画像回灌（冷启动恢复的一步）。
 *
 * 语义是**对齐**，不是补全：`state/user-profile.json` 里有的工作区照抄，
 * 文件里没有的工作区保持本机现状。
 *
 * 为什么"文件不存在就什么都不做"是硬规则：
 * 老版本快照（v0.2.0 之前）根本没有这个文件。若把"没有文件"当成"画像为空"，
 * 升级后的第一次冷启动就会把用户辛苦填的名字清掉——而这件事**不报错**，
 * 用户只会觉得"它又开始乱叫人了"。
 */
import type { SqlDriver } from '../../shared/types.js'
import { UserProfileStore } from '../memory/user-profile.js'
import { mergeByKey, readStateFiles } from './state-read.js'

export interface UserProfilesStateFile {
  readonly version?: number
  readonly device?: string
  readonly capturedAt?: number
  readonly profiles?: readonly {
    readonly workspaceId?: string
    readonly displayName?: string
    readonly preferredAddress?: string
    readonly notes?: string
  }[]
}

export interface UserProfileRehydrateResult {
  /** 快照里到底有没有这个文件（决定"是空画像"还是"这版快照不记画像"）。 */
  readonly present: boolean
  readonly profiles: number
  readonly failed: number
}

export async function rehydrateUserProfilesFromRepo(options: {
  readonly db: SqlDriver
  readonly root: string
  readonly clock?: () => number
  readonly onWarn?: (message: string) => void
  /** 快照捕获时刻（manifest.createdAt）。回灌的时间守卫用它，不是恢复时刻。 */
  readonly capturedAt?: number
}): Promise<UserProfileRehydrateResult> {
  const warn = options.onWarn ?? (() => {})

  // 多设备格式：state/<deviceId>/user-profile.json 按 workspaceId LWW 合并。
  const collection = await readStateFiles(options.root, 'user-profile.json', warn)
  if (collection.parsed.length === 0) {
    // 没有文件 = 老快照，绝不动本机已有的画像；文件在但坏了 = 上报失败。
    return { present: collection.present, profiles: 0, failed: collection.failures }
  }
  const merged = mergeByKey(
    collection.parsed,
    (chunk) => {
      const file = chunk as unknown as UserProfilesStateFile
      return Array.isArray(file.profiles) ? file.profiles ?? [] : []
    },
    (item) => (typeof item.workspaceId === 'string' ? item.workspaceId : ''),
  )
  // V62-07/T1：回灌的 updated_at 必须用快照 capturedAt（而非"恢复时刻"），否则
  // journal 全量重放后跑回灌，MAX 比较总判"回灌更新"，旧快照画像覆盖新画像。
  // capturedAt 的真相在 manifest.createdAt（engine 刻意不写 state 文件的 capturedAt
  // 字段，为保逐字节确定），所以由调用方（restore.ts）显式传入，不从这里读文件。
  const capturedAt = options.capturedAt

  const store = new UserProfileStore({ db: options.db, clock: options.clock })
  let profiles = 0
  let failed = 0
  for (const item of merged.values()) {
    const workspaceId = typeof item.workspaceId === 'string' ? item.workspaceId : ''
    if (workspaceId === '') {
      failed++
      continue
    }
    try {
      store.replace(
        workspaceId,
        {
          displayName: item.displayName ?? '',
          preferredAddress: item.preferredAddress ?? '',
          notes: item.notes ?? '',
        },
        'snapshot',
        capturedAt,
      )
      profiles++
    } catch {
      failed++
    }
  }
  return { present: true, profiles, failed: failed + collection.failures }
}
