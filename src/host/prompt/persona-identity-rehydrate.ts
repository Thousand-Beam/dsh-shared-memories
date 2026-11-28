/**
 * 会话 → 人格 绑定的回灌（冷启动恢复的一步）。
 *
 * 为什么它必须跟着快照走：人格数据（persona_state）与记忆都在，但"哪个会话 id
 * 归哪个人格"是本机事件流里产生的。设备 B 恢复后如果没有这张表，B 上开的新会话
 * 找不到绑定，就又退回"新会话 = 新人格 = 空记忆"——用户看到的是"云脑没生效"。
 *
 * 语义同技能/画像：文件不存在就**一条都不动**。老快照（v0.2.1 之前）没有这个文件，
 * 若把"没有文件"当成"没有任何绑定"，升级后第一次冷启动就会把本机的继承关系清空。
 */
import type { SqlDriver } from '../../shared/types.js'
import type { PersonaIdentity } from '../../shared/persona-identity.js'
import { PersonaIdentityStore } from '../memory/persona-identity.js'
import { mergeByKey, readStateFiles } from './state-read.js'

export interface PersonaIdentityStateFile {
  readonly version?: number
  readonly device?: string
  readonly capturedAt?: number
  readonly identities?: readonly {
    readonly agentId?: string
    readonly workspaceId?: string
    readonly personaId?: string
    readonly boundAt?: number
    readonly lastSeenAt?: number
  }[]
}

export interface PersonaIdentityRehydrateResult {
  /** 快照里到底有没有这个文件。 */
  readonly present: boolean
  readonly identities: number
  readonly failed: number
}

export async function rehydratePersonaIdentitiesFromRepo(options: {
  readonly db: SqlDriver
  readonly root: string
  readonly clock?: () => number
  /**
   * 这份快照代表哪一刻（manifest.createdAt）。回灌发生在 journal 全量重放之后，
   * 若用它当守卫基准，"本机刚重放出来的绑定"就会输给旧快照；所以调用方必须传。
   */
  readonly capturedAt?: number
  readonly onWarn?: (message: string) => void
}): Promise<PersonaIdentityRehydrateResult> {
  const warn = options.onWarn ?? (() => {})

  // 多设备格式：state/<deviceId>/persona-identity.json 按 agentId|workspaceId LWW 合并。
  const collection = await readStateFiles(options.root, 'persona-identity.json', warn)
  if (collection.parsed.length === 0) {
    // 没有文件 = 老快照，绝不动本机已有的绑定；文件在但坏了 = 上报失败。
    return { present: collection.present, identities: 0, failed: collection.failures }
  }
  const merged = mergeByKey(
    collection.parsed,
    (chunk) => {
      const file = chunk as unknown as PersonaIdentityStateFile
      return Array.isArray(file.identities) ? file.identities ?? [] : []
    },
    (item) => {
      const agentId = typeof item.agentId === 'string' ? item.agentId : ''
      const workspaceId = typeof item.workspaceId === 'string' ? item.workspaceId : ''
      return agentId === '' || workspaceId === '' ? '' : `${agentId}\u0000${workspaceId}`
    },
  )

  const store = new PersonaIdentityStore({ db: options.db, clock: options.clock })
  const now = options.clock?.() ?? Date.now()
  // 缺省退回本机时钟 = 修复前行为（老调用点语义不变），但带了 capturedAt 就必须用它：
  // 文件里没写时间时，用"现在"会让守卫恒真，旧快照重新绑回旧人格（第五次同构缺陷）。
  const fallbackAt = options.capturedAt ?? now
  let identities = 0
  let failed = 0
  for (const item of merged.values()) {
    const agentId = typeof item.agentId === 'string' ? item.agentId : ''
    const workspaceId = typeof item.workspaceId === 'string' ? item.workspaceId : ''
    const personaId = typeof item.personaId === 'string' ? item.personaId : ''
    if (agentId === '' || workspaceId === '' || personaId === '') {
      failed++
      continue
    }
    const boundAt = typeof item.boundAt === 'number' && Number.isFinite(item.boundAt) ? item.boundAt : fallbackAt
    const lastSeenAt =
      typeof item.lastSeenAt === 'number' && Number.isFinite(item.lastSeenAt) ? item.lastSeenAt : boundAt
    const identity: PersonaIdentity = { agentId, workspaceId, personaId, boundAt, lastSeenAt }
    try {
      store.replace(identity)
      identities++
    } catch {
      failed++
    }
  }
  return { present: true, identities, failed: failed + collection.failures }
}
