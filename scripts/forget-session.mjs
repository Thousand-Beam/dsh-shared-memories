#!/usr/bin/env node
/**
 * forget-session.mjs — 把一条会话从「宿主侧」彻底抹掉
 * ---------------------------------------------------------------------------
 * 「彻底销毁」原本只清记忆库和 journal，侧栏那一行却来自别处：
 *
 *   ~/.dsh/sessions/<cwd-slug>/<sessionId>/         会话日志（含 session- 前缀的另一种命名）
 *   ~/.dsh/storages/session_projcache/sessions/<id>.json   投影缓存（标题/时间）
 *   ~/.dsh/storages/workspace.json                  记账：sessionIds / archivedSessionIds / pinnedSessionIds
 *
 * 只归档（archivedSessionIds）时那一行仍会渲染 —— 这就是"记忆删了、会话还在"的空壳。
 * 这个脚本把上面三处一起清掉，清完重启 DSH，那一行就真的不存在了。
 *
 * 用法：
 *   node scripts/forget-session.mjs --list                  # 只看：每条会话有没有记忆、有没有痕迹
 *   node scripts/forget-session.mjs <sessionId>             # 干跑（只打印将要做什么）
 *   node scripts/forget-session.mjs <sessionId> --apply     # 真删（先备份 workspace.json）
 *   node scripts/forget-session.mjs --all-orphans --apply    # 删掉所有"0 条记忆"的空壳会话
 *
 * 安全：默认干跑；--apply 才会落盘；workspace.json 先备份成 workspace.json.bak-<ms>。
 */

import { copyFile, mkdir, readFile, readdir, rename, rm, stat, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { basename, dirname, join } from 'node:path'

const args = process.argv.slice(2)

function flag(name) {
  return args.includes(name)
}

function valueOf(name) {
  const index = args.indexOf(name)
  return index >= 0 ? args[index + 1] : undefined
}

const apply = flag('--apply')
const listOnly = flag('--list')
const allOrphans = flag('--all-orphans')
const dshHome = valueOf('--root') ?? join(homedir(), '.dsh')

const SESSIONS_DIR = join(dshHome, 'sessions')
const CACHE_DIR = join(dshHome, 'storages', 'session_projcache', 'sessions')
const REGISTRY = join(dshHome, 'storages', 'workspace.json')
const MEMORY_DB = join(dshHome, 'shared-memories', 'memory.db')

/** `session-<uuid>` 与裸 `<uuid>` 是同一条会话的两种落盘命名。 */
function bare(id) {
  return id.startsWith('session-') ? id.slice('session-'.length) : id
}

function same(a, b) {
  return bare(a) === bare(b)
}

async function exists(path) {
  try {
    await stat(path)
    return true
  } catch {
    return false
  }
}

async function readJson(path) {
  const raw = await readFile(path, 'utf8')
  return JSON.parse(raw)
}

/** 原子写：临时文件 + rename（同目录，不会跨卷）。 */
async function writeJsonAtomic(path, doc) {
  const tmp = `${path}.tmp-${process.pid}`
  await writeFile(tmp, `${JSON.stringify(doc, null, 2)}\n`, 'utf8')
  await rename(tmp, path)
}

/** 记忆库里有几条实体（按 agent_id 分组）——用来判断"这条会话还有没有记忆"。 */
async function entityCounts() {
  const counts = new Map()
  let db
  try {
    const { DatabaseSync } = await import('node:sqlite')
    db = new DatabaseSync(MEMORY_DB, { readOnly: true })
    const rows = db.prepare('SELECT agent_id AS agentId, COUNT(*) AS n FROM memory_entity GROUP BY agent_id').all()
    for (const row of rows) counts.set(row.agentId, Number(row.n))
  } catch (cause) {
    console.warn(`[warn] 读记忆库失败（不影响清理）：${cause?.message ?? cause}`)
  } finally {
    try {
      db?.close()
    } catch {
      /* 关了就行 */
    }
  }
  return counts
}

/** workspace.json 里登记的所有会话 id。 */
function registeredSessions(registry) {
  const ids = new Set()
  const workspaces = registry?.tables?.workspaces
  if (workspaces !== null && typeof workspaces === 'object') {
    for (const entry of Object.values(workspaces)) {
      if (Array.isArray(entry?.sessionIds)) for (const id of entry.sessionIds) ids.add(id)
    }
  }
  return [...ids]
}

/** 某条会话在磁盘上留下的痕迹。 */
async function tracesOf(sessionId) {
  const found = []
  let slugs = []
  try {
    slugs = (await readdir(SESSIONS_DIR, { withFileTypes: true }))
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
  } catch {
    slugs = []
  }
  for (const slug of slugs) {
    if (slug === '.purge-trash') continue
    const dir = join(SESSIONS_DIR, slug)
    let names = []
    try {
      names = await readdir(dir)
    } catch {
      continue
    }
    for (const name of names) {
      if (same(name, sessionId)) found.push(join(dir, name))
    }
  }
  let cacheNames = []
  try {
    cacheNames = await readdir(CACHE_DIR)
  } catch {
    cacheNames = []
  }
  for (const name of cacheNames) {
    if (same(name.replace(/\.json$/u, ''), sessionId)) found.push(join(CACHE_DIR, name))
  }
  return found
}

async function discard(path) {
  const trash = join(dirname(path), '.purge-trash')
  try {
    await mkdir(trash, { recursive: true })
    const parked = join(trash, `${basename(path)}-${Date.now()}`)
    await rename(path, parked)
    await rm(parked, { recursive: true, force: true, maxRetries: 3 }).catch(() => undefined)
    return 'renamed'
  } catch {
    await rm(path, { recursive: true, force: true, maxRetries: 3 })
    return 'removed'
  }
}

function pruneRegistry(registry, sessionIds) {
  const hits = []
  const matches = (value) => typeof value === 'string' && sessionIds.some((id) => same(value, id))
  const prune = (list, label) => {
    if (!Array.isArray(list)) return list
    const kept = list.filter((value) => !matches(value))
    for (const value of list) if (matches(value)) hits.push(`${label}:${value}`)
    return kept
  }
  const global = registry?.global
  if (global !== null && typeof global === 'object') {
    global.archivedSessionIds = prune(global.archivedSessionIds, 'archived')
    global.pinnedSessionIds = prune(global.pinnedSessionIds, 'pinned')
  }
  const workspaces = registry?.tables?.workspaces
  if (workspaces !== null && typeof workspaces === 'object') {
    for (const [id, entry] of Object.entries(workspaces)) {
      if (entry === null || typeof entry !== 'object') continue
      entry.sessionIds = prune(entry.sessionIds, `workspace/${id.slice(0, 8)}`)
    }
  }
  return hits
}

async function main() {
  console.log(`root: ${dshHome}`)
  const registry = (await exists(REGISTRY)) ? await readJson(REGISTRY) : { tables: { workspaces: {} } }
  const counts = await entityCounts()
  const sessions = registeredSessions(registry)

  if (listOnly || (args.length === 0 && !allOrphans)) {
    console.log(`\n登记在 workspace.json 里的会话共 ${sessions.length} 条：\n`)
    for (const id of sessions) {
      const traces = await tracesOf(id)
      const n = counts.get(id) ?? 0
      const mark = n === 0 ? '空壳' : `${n} 条记忆`
      console.log(`  ${id}  [${mark}]  痕迹 ${traces.length} 个`)
    }
    const ghosts = sessions.filter((id) => (counts.get(id) ?? 0) === 0)
    if (ghosts.length > 0) {
      console.log(`\n0 条记忆的空壳 ${ghosts.length} 条：`)
      for (const id of ghosts) console.log(`  ${id}`)
      console.log('\n删掉某个：node scripts/forget-session.mjs <sessionId> --apply')
      console.log('全删掉：  node scripts/forget-session.mjs --all-orphans --apply')
    }
    return
  }

  const explicit = args.find((arg) => !arg.startsWith('-') && arg !== valueOf('--root'))
  const targets = allOrphans ? sessions.filter((id) => (counts.get(id) ?? 0) === 0) : explicit ? [explicit] : []
  if (targets.length === 0) {
    console.error(`\n没给出 sessionId。先跑：node scripts/forget-session.mjs --list`)
    process.exitCode = 1
    return
  }

  console.log(`\n目标 ${targets.length} 条：${targets.join(', ')}`)
  if (!apply) {
    for (const id of targets) {
      const traces = await tracesOf(id)
      console.log(`\n[dry-run] ${id}`)
      console.log(`  记忆实体：${counts.get(id) ?? 0}`)
      console.log(`  会话痕迹：${traces.length} 个`)
      for (const path of traces) console.log(`    - ${path}`)
      console.log(`  记账：将从 sessionIds / archivedSessionIds / pinnedSessionIds 剔除`)
    }
    console.log('\n加 --apply 才会真的删。')
    return
  }

  if (await exists(REGISTRY)) {
    const backup = `${REGISTRY}.bak-${Date.now()}`
    await copyFile(REGISTRY, backup)
    console.log(`\n已备份记账：${backup}`)
  }

  let files = 0
  for (const id of targets) {
    for (const path of await tracesOf(id)) {
      const how = await discard(path)
      files += 1
      console.log(`  ${how === 'renamed' ? '移入回收区' : '直接删除'}  ${path}`)
    }
  }

  const hits = pruneRegistry(registry, targets)
  const changed = hits.length > 0
  if (changed) {
    await writeJsonAtomic(REGISTRY, registry)
    console.log(`\n记账剔除 ${hits.length} 条：`)
    for (const hit of hits) console.log(`  - ${hit}`)
  }

  console.log(`\n完成：${targets.length} 条会话，${files} 个文件，${hits.length} 条记账。`)
  console.log('现在重启 DSH：侧栏那一行不会再被扫出来。')
}

await main()
