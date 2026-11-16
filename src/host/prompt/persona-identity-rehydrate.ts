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
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { SqlDriver } from '../../shared/types.js'
import type { PersonaIdentity } from '../../shared/persona-identity.js'
import { PersonaIdentityStore } from '../memory/persona-identity.js'

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
  readonly onWarn?: (message: string) => void
}): Promise<PersonaIdentityRehydrateResult> {
  const warn = options.onWarn ?? (() => {})
  const path = join(options.root, 'state', 'persona-identity.json')

  let raw: string
  try {
    raw = await readFile(path, 'utf8')
  } catch {
    // 没有文件 = 老快照，绝不动本机已有的绑定。
    return { present: false, identities: 0, failed: 0 }
  }

  let parsed: PersonaIdentityStateFile
  try {
    parsed = JSON.parse(raw) as PersonaIdentityStateFile
  } catch {
    warn('身份绑定回灌：state/persona-identity.json 解析失败，保留本机现状')
    return { present: true, identities: 0, failed: 1 }
  }

  const store = new PersonaIdentityStore({ db: options.db, clock: options.clock })
  const now = options.clock?.() ?? Date.now()
  let identities = 0
  let failed = 0
  for (const item of parsed.identities ?? []) {
    const agentId = typeof item.agentId === 'string' ? item.agentId : ''
    const workspaceId = typeof item.workspaceId === 'string' ? item.workspaceId : ''
    const personaId = typeof item.personaId === 'string' ? item.personaId : ''
    if (agentId === '' || workspaceId === '' || personaId === '') {
      failed++
      continue
    }
    const boundAt = typeof item.boundAt === 'number' && Number.isFinite(item.boundAt) ? item.boundAt : now
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
  return { present: true, identities, failed }
}
