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
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { SqlDriver } from '../../shared/types.js'
import { UserProfileStore } from '../memory/user-profile.js'

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
}): Promise<UserProfileRehydrateResult> {
  const warn = options.onWarn ?? (() => {})
  const path = join(options.root, 'state', 'user-profile.json')

  let raw: string
  try {
    raw = await readFile(path, 'utf8')
  } catch {
    // 没有文件 = 老快照，绝不动本机已有的画像。
    return { present: false, profiles: 0, failed: 0 }
  }

  let parsed: UserProfilesStateFile
  try {
    parsed = JSON.parse(raw) as UserProfilesStateFile
  } catch {
    warn('用户画像回灌：state/user-profile.json 解析失败，保留本机现状')
    return { present: true, profiles: 0, failed: 1 }
  }

  const store = new UserProfileStore({ db: options.db, clock: options.clock })
  let profiles = 0
  let failed = 0
  for (const item of parsed.profiles ?? []) {
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
      )
      profiles++
    } catch {
      failed++
    }
  }
  return { present: true, profiles, failed }
}
