/**
 * 会话本体（不是记忆）的清除。
 *
 * 我们的 `purgeAgent` 只动记忆库：实体、版本、踩坑、隔离、画像、技能、会话策略，
 * 再加上 journal 墓碑。但侧栏里那一行会话是 **DSH 自己的数据**，跟记忆库无关——
 * 所以"彻底销毁"之后，用户仍然能在列表里看到它（只是被归档、变灰）。
 *
 * DSH 没有对外暴露 deleteSession，会话本体落在两处：
 *   1. `<DSH_HOME>/storages/session_projcache/sessions/<id>.json` —— 会话投影（标题、todos…）
 *   2. `<DSH_HOME>/storages/workspace.json` 的 `archivedSessionIds` / 工作区 sessionIds
 * 把这两处抹掉，重启桌面端后那一行才会真的消失。
 *
 * 这里刻意保持"能手改、能回滚"：动 workspace.json 之前先留一份 `.bak-<ts>`。
 */
import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { basename, join } from 'node:path'

export interface RemoveSessionOptions {
  /** 会话 id（DSH 的 session-xxx 或裸 uuid）。 */
  readonly sessionId: string
  /** DSH 主目录，通常是 `<repo>/..`，即 `~/.dsh`。 */
  readonly dshHome: string
  readonly clock?: () => number
  readonly onWarn?: (message: string) => void
}

export interface RemoveSessionResult {
  /** 投影文件是否真的删掉了。 */
  readonly projection: boolean
  /** workspace.json 的索引是否改动了（有引用才算）。 */
  readonly indexUpdated: boolean
}

/** 从任意嵌套结构里摘掉等于 sessionId 的数组元素，返回是否有改动。 */
function stripId(node: unknown, sessionId: string): boolean {
  let changed = false
  if (Array.isArray(node)) {
    for (let index = node.length - 1; index >= 0; index--) {
      if (node[index] === sessionId) {
        node.splice(index, 1)
        changed = true
      } else if (typeof node[index] === 'object' && node[index] !== null) {
        if (stripId(node[index], sessionId)) changed = true
      }
    }
    return changed
  }
  if (typeof node === 'object' && node !== null) {
    for (const value of Object.values(node as Record<string, unknown>)) {
      if (typeof value === 'object' && value !== null) {
        if (stripId(value, sessionId)) changed = true
      }
    }
  }
  return changed
}

export function removeSessionArtifacts(options: RemoveSessionOptions): RemoveSessionResult {
  const { sessionId, dshHome } = options
  const warn = options.onWarn ?? (() => {})
  if (sessionId.trim() === '') return { projection: false, indexUpdated: false }
  // 防路径穿越：会话 id 只能是一个文件名，绝不允许带分隔符或 ..
  if (basename(sessionId) !== sessionId || sessionId === '.' || sessionId === '..') {
    warn(`拒绝非法会话 id（可能是路径穿越）：${sessionId}`)
    return { projection: false, indexUpdated: false }
  }

  let projection = false
  const projectionPath = join(dshHome, 'storages', 'session_projcache', 'sessions', `${sessionId}.json`)
  try {
    if (existsSync(projectionPath)) {
      rmSync(projectionPath, { force: true })
      projection = true
    }
  } catch (cause) {
    warn(`删除会话投影失败（${sessionId}）：${cause instanceof Error ? cause.message : String(cause)}`)
  }

  let indexUpdated = false
  const indexPath = join(dshHome, 'storages', 'workspace.json')
  try {
    if (existsSync(indexPath)) {
      const raw = readFileSync(indexPath, 'utf8')
      const parsed = JSON.parse(raw) as unknown
      if (stripId(parsed, sessionId)) {
        const stamp = Math.round((options.clock ?? Date.now)())
        writeFileSync(`${indexPath}.bak-${stamp}`, raw, 'utf8')
        writeFileSync(indexPath, `${JSON.stringify(parsed, null, 2)}\n`, 'utf8')
        indexUpdated = true
      }
    }
  } catch (cause) {
    warn(`更新会话索引失败（${sessionId}）：${cause instanceof Error ? cause.message : String(cause)}`)
  }

  return { projection, indexUpdated }
}
