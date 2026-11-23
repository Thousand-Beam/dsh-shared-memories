#!/usr/bin/env node
/**
 * clean-ghost.mjs —— 手动清除"借尸还魂"的幽灵记忆。
 *
 * 背景：`彻底销毁` 会同时删库 + 改写 journal + 写 purge 墓碑。如果其中一步在
 * Windows 上被文件占用打断（EBUSY/EPERM），进程可能来不及写墓碑，于是：
 *   journal 里的正文还在 → 下次冷启动 replay 把它重新建成 DB 行 → 记忆复活。
 *
 * 这个脚本干三件事：
 *   ① 体检：找出"有墓碑但仍活着"的 agent，列出它在库 / journal / state 里的残留；
 *   ② 清理（--apply）：删库行 → 物理剔除 journal 记录 → 删 persona 文件 →
 *      洗 state JSON → **最后**补写一条新墓碑（时间戳强制递增，保证 replay 顺序在后面）；
 *   ③ 复检：清理后重新统计一遍，把还剩下的东西打出来，方便你判断要不要再跑一次。
 *
 * 设计原则（和 purge.ts 一致）：
 *   - 默认 dry-run，什么都不写；
 *   - 写文件一律 临时文件 → fsync → rename，失败退避重试，绝不先删原文件；
 *   - 全部包在 try/catch 里，出错只打印 + 退出码，不会把 DSH 宿主带走；
 *   - --apply 前先整包备份到 `<root>/backups/clean-ghost-<时间戳>/`。
 *
 * 用法：
 *   node scripts/clean-ghost.mjs                      # 体检，找所有幽灵
 *   node scripts/clean-ghost.mjs --agent <AGENT_ID>   # 体检指定 agent
 *   node scripts/clean-ghost.mjs --apply              # 真删（会先备份）
 *   node scripts/clean-ghost.mjs --apply --agent <AGENT_ID> --yes
 *   node scripts/clean-ghost.mjs --root "D:\\data\\shared-memories" --workspace <WS_ID>
 *
 * 参数：
 *   --root <dir>        数据根，默认 %USERPROFILE%\.dsh\shared-memories
 *   --workspace <id>    只处理该 workspace（默认：自动发现）
 *   --agent <id>        只处理该 agent（默认：所有有墓碑的 agent）
 *   --apply             执行清理（默认只读体检）
 *   --yes               配合 --apply 跳过交互确认（CI / 非 TTY 用）
 *   --no-journal        跳过 journal 改写（只删库，不推荐：replay 会复活）
 *   --no-backup         跳过备份（危险，只在磁盘快满时用）
 *   --json              以 JSON 输出体检结果
 *
 * 退出码：0 = 干净/成功；1 = 出错；2 = 部分成功（有残留，建议再跑一次）。
 *
 * 注意：跑之前最好先关掉 DSH。宿主活着时它有自己的 WAL 连接和 seq 计数，
 * 这边刚清完，它可能又把内存里的状态刷回去。
 */

import { homedir } from 'node:os'
import { join, dirname, basename, resolve } from 'node:path'
import { cp, mkdir, open, readFile, readdir, rename, stat, unlink } from 'node:fs/promises'

// ── 参数解析 ────────────────────────────────────────────────────────────────

function parseArgs(argv) {
  const out = {
    root: join(homedir(), '.dsh', 'shared-memories'),
    workspace: '',
    agent: '',
    apply: false,
    yes: false,
    journal: true,
    backup: true,
    json: false,
  }
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    switch (arg) {
      case '--root':
        out.root = argv[++i] ?? out.root
        break
      case '--workspace':
        out.workspace = argv[++i] ?? ''
        break
      case '--agent':
        out.agent = argv[++i] ?? ''
        break
      case '--apply':
        out.apply = true
        break
      case '--yes':
        out.yes = true
        out.apply = true
        break
      case '--no-journal':
        out.journal = false
        break
      case '--no-backup':
        out.backup = false
        break
      case '--json':
        out.json = true
        break
      case '-h':
      case '--help':
        printHelp()
        process.exit(0)
      // eslint-disable-next-line no-fallthrough
      default:
        if (arg.startsWith('-')) fail(`未知参数：${arg}（--help 看用法）`)
    }
  }
  return out
}

function printHelp() {
  console.log(`
clean-ghost.mjs —— 清除"借尸还魂"的幽灵记忆

  node scripts/clean-ghost.mjs [选项]

  --root <dir>        数据根，默认 ${join(homedir(), '.dsh', 'shared-memories')}
  --workspace <id>    只处理该 workspace
  --agent <id>        只处理该 agent
  --apply             执行清理（默认只读体检）
  --yes               跳过确认（隐含 --apply）
  --no-journal        不改写 journal（只删库）
  --no-backup         不备份
  --json              体检结果输出 JSON
`)
}

// ── 小工具 ──────────────────────────────────────────────────────────────────

const RETRYABLE = new Set(['EBUSY', 'EPERM', 'EACCES', 'EMFILE', 'ENFILE', 'EAGAIN'])

function messageOf(cause) {
  return cause instanceof Error ? cause.message : String(cause)
}

function codeOf(cause) {
  const code = cause && typeof cause === 'object' ? cause.code : undefined
  return typeof code === 'string' ? code : ''
}

function sleep(ms) {
  return new Promise((done) => setTimeout(done, ms))
}

async function withRetry(fn, attempts = 6) {
  let last
  for (let i = 0; i < attempts; i++) {
    try {
      return await fn()
    } catch (cause) {
      last = cause
      if (!RETRYABLE.has(codeOf(cause))) throw cause
      await sleep(25 * 2 ** i)
    }
  }
  throw last
}

async function exists(path) {
  try {
    await stat(path)
    return true
  } catch {
    return false
  }
}

async function safeUnlink(path) {
  try {
    await unlink(path)
  } catch {
    // 不存在就算了
  }
}

/**
 * 安全覆盖：临时文件 → fsync → rename。
 * rename 失败（Windows 上目标被占用）退避重试，仍失败则原地截断重写并回读校验。
 */
async function atomicReplace(file, text) {
  const tmp = `${file}.clean-ghost-${process.pid}.tmp`
  const data = Buffer.from(text, 'utf8')
  try {
    await withRetry(async () => {
      await mkdir(dirname(file), { recursive: true })
      const handle = await open(tmp, 'w')
      try {
        await handle.writeFile(data)
        await handle.sync()
      } finally {
        await handle.close()
      }
    })
    try {
      await withRetry(() => rename(tmp, file))
      return 'renamed'
    } catch (cause) {
      // 退路：原地覆盖。先把内容写进去再校验长度，避免 rename 不通时丢数据。
      await withRetry(async () => {
        const handle = await open(file, 'r+')
        try {
          await handle.truncate(0)
          await handle.write(data, 0, data.length, 0)
          await handle.sync()
        } finally {
          await handle.close()
        }
      })
      const back = await readFile(file)
      if (back.length !== data.length) {
        throw new Error(`原地覆盖后长度不符（${back.length} != ${data.length}）：${messageOf(cause)}`)
      }
      return 'overwritten'
    }
  } finally {
    await safeUnlink(tmp)
  }
}

function fail(message) {
  console.error(`✖ ${message}`)
  process.exit(1)
}

function utcDate(ms = Date.now()) {
  return new Date(ms).toISOString().slice(0, 10)
}

function stamp() {
  return new Date().toISOString().replace(/[:.]/g, '-')
}

// ── sqlite（node:sqlite，Node >= 22.5；22.x 需 --experimental-sqlite） ──────

async function openDb(file, readOnly) {
  let mod
  try {
    mod = await import('node:sqlite')
  } catch (cause) {
    fail(`node:sqlite 不可用（需要 Node >= 22.5，22.x 请加 --experimental-sqlite）：${messageOf(cause)}`)
  }
  if (typeof mod.DatabaseSync !== 'function') fail('node:sqlite 缺少 DatabaseSync')
  const db = new mod.DatabaseSync(file, readOnly ? { readOnly: true } : undefined)
  try {
    db.exec('PRAGMA busy_timeout = 8000')
  } catch {
    // 只读连接上设不了就算了
  }
  return db
}

function all(db, sql, params = []) {
  const stmt = db.prepare(sql)
  return stmt.all(...params)
}

function run(db, sql, params = []) {
  const stmt = db.prepare(sql)
  return stmt.run(...params)
}

function tableColumns(db, table) {
  try {
    return all(db, `PRAGMA table_info(${table})`).map((row) => String(row.name))
  } catch {
    return []
  }
}

function tableExists(db, table) {
  try {
    const rows = all(db, "SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?", [table])
    return rows.length > 0
  } catch {
    return false
  }
}

// ── journal ────────────────────────────────────────────────────────────────

async function listJournalFiles(root) {
  const base = join(root, 'journal', 'devices')
  const out = []
  let devices = []
  try {
    devices = await readdir(base, { withFileTypes: true })
  } catch {
    return out
  }
  for (const device of devices) {
    if (!device.isDirectory()) continue
    const dir = join(base, device.name)
    let files = []
    try {
      files = await readdir(dir, { withFileTypes: true })
    } catch {
      continue
    }
    for (const file of files) {
      if (!file.isFile() || !file.name.endsWith('.jsonl')) continue
      out.push({ device: device.name, path: join(dir, file.name) })
    }
  }
  return out
}

function parseLines(text) {
  return text.split('\n').filter((line) => line.trim() !== '')
}

function parseRecord(line) {
  try {
    const value = JSON.parse(line)
    if (value && typeof value === 'object' && !Array.isArray(value)) return value
  } catch {
    // 坏行原样保留，绝不因为一行垃圾就把整份 journal 写坏
  }
  return null
}

/** 读所有墓碑：op === 'agent.purge' */
async function readTombstones(root) {
  const map = new Map()
  for (const file of await listJournalFiles(root)) {
    let text
    try {
      text = await readFile(file.path, 'utf8')
    } catch {
      continue
    }
    for (const line of parseLines(text)) {
      const rec = parseRecord(line)
      if (!rec || rec.op !== 'agent.purge') continue
      const agentId = typeof rec.agentId === 'string' ? rec.agentId : ''
      if (!agentId) continue
      const at = typeof rec.at === 'number' ? rec.at : 0
      const prev = map.get(agentId)
      if (!prev || at > prev.at) map.set(agentId, { agentId, at, workspaceId: rec.workspaceId ?? '', file: file.path })
    }
  }
  return map
}

/**
 * 一条 journal 记录是否属于该 agent。
 * 三类都要匹配：带 agentId 的、只带 entityId 的（version.open/close）、只带 personaId 的（绑定）。
 */
function belongsTo(rec, agentId, workspaceId, entityIds) {
  if (typeof rec.agentId === 'string' && rec.agentId === agentId) {
    if (!workspaceId || !rec.workspaceId || rec.workspaceId === workspaceId) return true
  }
  if (typeof rec.personaId === 'string' && rec.personaId === agentId) return true
  if (typeof rec.entityId === 'string' && entityIds.has(rec.entityId)) return true
  return false
}

async function appendTombstone(root, workspaceId, agentId, at) {
  const file = join(root, 'journal', 'devices', 'purge', `${utcDate(at)}.jsonl`)
  let text = ''
  try {
    text = await readFile(file, 'utf8')
  } catch {
    text = ''
  }
  let maxSeq = -1
  for (const line of parseLines(text)) {
    const rec = parseRecord(line)
    if (rec && typeof rec.seq === 'number' && rec.seq > maxSeq) maxSeq = rec.seq
  }
  const record = {
    seq: maxSeq + 1,
    op: 'agent.purge',
    workspaceId,
    agentId,
    at,
    deviceId: 'purge',
  }
  const prefix = text === '' || text.endsWith('\n') ? text : `${text}\n`
  await atomicReplace(file, `${prefix}${JSON.stringify(record)}\n`)
  return record
}

// ── state 文件清洗 ─────────────────────────────────────────────────────────

function scrubJson(value, agentId) {
  if (Array.isArray(value)) {
    return value
      .filter((item) => {
        if (!item || typeof item !== 'object' || Array.isArray(item)) return true
        return !(
          item.agentId === agentId ||
          item.agent_id === agentId ||
          item.personaId === agentId ||
          item.persona_id === agentId
        )
      })
      .map((item) => scrubJson(item, agentId))
  }
  if (value && typeof value === 'object') {
    const out = {}
    for (const [key, inner] of Object.entries(value)) {
      if (key === agentId) continue
      out[key] = scrubJson(inner, agentId)
    }
    return out
  }
  return value
}

async function scrubStateFile(file, agentId, report) {
  if (!(await exists(file))) return
  let doc
  try {
    doc = JSON.parse(await readFile(file, 'utf8'))
  } catch (cause) {
    report.warnings.push(`状态文件解析失败，跳过 ${basename(file)}：${messageOf(cause)}`)
    return
  }
  const before = JSON.stringify(doc)
  const after = JSON.stringify(scrubJson(doc, agentId))
  if (before === after) return
  await atomicReplace(file, `${JSON.stringify(scrubJson(doc, agentId), null, 2)}\n`)
  report.stateFiles.push(file)
}

// ── 备份 ───────────────────────────────────────────────────────────────────

async function backup(root) {
  const dir = join(root, 'backups', `clean-ghost-${stamp()}`)
  await mkdir(dir, { recursive: true })
  for (const name of ['memory.db', 'memory.db-wal', 'memory.db-shm']) {
    const from = join(root, name)
    if (await exists(from)) {
      await cp(from, join(dir, name))
    }
  }
  for (const name of ['journal', 'persona', 'state']) {
    const from = join(root, name)
    if (await exists(from)) {
      await cp(from, join(dir, name), { recursive: true })
    }
  }
  return dir
}

// ── 体检 ───────────────────────────────────────────────────────────────────

async function inspect(db, root, options, agentId, workspaceId, tombstones) {
  const entityIds = new Set()
  const tables = {}
  const columnsOf = (table) => tableColumns(db, table)

  const entityRows = all(
    db,
    'SELECT entity_id, kind, created_at FROM memory_entity WHERE agent_id = ? AND (? = \'\' OR workspace_id = ?)',
    [agentId, workspaceId, workspaceId],
  )
  for (const row of entityRows) entityIds.add(String(row.entity_id))

  tables.memory_entity = entityRows.length
  const createdAt = entityRows.map((row) => Number(row.created_at) || 0).filter((n) => n > 0)
  const firstAt = createdAt.length > 0 ? Math.min(...createdAt) : 0
  const lastAt = createdAt.length > 0 ? Math.max(...createdAt) : 0

  const countWhere = (table, extra = '') => {
    if (!tableExists(db, table)) return 0
    const cols = columnsOf(table)
    if (!cols.includes('agent_id')) return 0
    const conds = ['agent_id = ?']
    const params = [agentId]
    if (cols.includes('workspace_id') && workspaceId) {
      conds.push('workspace_id = ?')
      params.push(workspaceId)
    }
    try {
      return all(db, `SELECT 1 FROM ${table} WHERE ${conds.join(' AND ')} ${extra}`, params).length
    } catch {
      return 0
    }
  }

  tables.memory_version = entityIds.size > 0
    ? (() => {
        try {
          const marks = [...entityIds].map(() => '?').join(',')
          return all(db, `SELECT version_id FROM memory_version WHERE entity_id IN (${marks})`, [...entityIds]).length
        } catch {
          return 0
        }
      })()
    : 0

  for (const table of ['pitfall', 'quarantine', 'persona_state', 'agent_skill', 'session_policy', 'audit_log']) {
    tables[table] = countWhere(table)
  }
  tables.persona_identity_agent = countWhere('persona_identity')

  let personaIdentityByPersona = 0
  if (tableExists(db, 'persona_identity')) {
    try {
      const rows = all(
        db,
        'SELECT agent_id FROM persona_identity WHERE persona_id = ? AND (? = \'\' OR workspace_id = ?)',
        [agentId, workspaceId, workspaceId],
      )
      personaIdentityByPersona = rows.length
    } catch {
      personaIdentityByPersona = 0
    }
  }
  tables.persona_identity_persona = personaIdentityByPersona

  // journal
  const journal = { files: 0, records: 0, byFile: [] }
  if (options.journal) {
    for (const file of await listJournalFiles(root)) {
      if (file.device === 'purge') continue
      let text
      try {
        text = await readFile(file.path, 'utf8')
      } catch {
        continue
      }
      let hits = 0
      for (const line of parseLines(text)) {
        const rec = parseRecord(line)
        if (rec && belongsTo(rec, agentId, workspaceId, entityIds)) hits++
      }
      if (hits > 0) {
        journal.files++
        journal.records += hits
        journal.byFile.push({ path: file.path, records: hits })
      }
    }
  }

  // state / persona
  const personaFile = join(root, 'persona', `${agentId}.json`)
  const stateFiles = ['persona-identity.json', 'agents.json', 'skills.json', 'user-profile.json'].map((name) =>
    join(root, 'state', name),
  )

  const tombstone = tombstones.get(agentId)

  return {
    agentId,
    workspaceId,
    tombstone,
    createdAt: { first: firstAt, last: lastAt },
    tables,
    journal,
    personaFile: (await exists(personaFile)) ? personaFile : '',
    stateFiles,
  }
}

function summarize(report) {
  const t = report.tables
  const lines = []
  lines.push(`  agent      ${report.agentId}`)
  lines.push(`  workspace  ${report.workspaceId || '(全部)'}`)
  if (report.tombstone) {
    const when = new Date(report.tombstone.at).toISOString()
    lines.push(`  墓碑       ${when}（${report.tombstone.file}）`)
  } else {
    lines.push('  墓碑       无')
  }
  if (report.createdAt.last > 0) {
    lines.push(
      `  实体时间   ${new Date(report.createdAt.first).toISOString()} → ${new Date(report.createdAt.last).toISOString()}`,
    )
  }
  lines.push('  库残留     ' + Object.entries(t).map(([k, v]) => `${k}=${v}`).join('  '))
  lines.push(`  journal    ${report.journal.files} 个文件 / ${report.journal.records} 条记录`)
  for (const item of report.journal.byFile.slice(0, 8)) {
    lines.push(`             - ${item.path}  (${item.records})`)
  }
  if (report.journal.byFile.length > 8) lines.push(`             … 另有 ${report.journal.byFile.length - 8} 个文件`)
  lines.push(`  persona    ${report.personaFile || '(无)'}`)
  return lines.join('\n')
}

function residualOf(report) {
  const items = []
  for (const [table, count] of Object.entries(report.tables)) {
    if (count > 0) items.push(`${table}=${count}`)
  }
  if (report.journal.records > 0) items.push(`journal=${report.journal.records}`)
  if (report.personaFile) items.push('persona=<id>.json')
  return items
}

// ── 清理 ───────────────────────────────────────────────────────────────────

async function applyClean(db, root, options, report, tombstones) {
  const { agentId, workspaceId } = report
  const failures = []
  const dealt = { rows: 0, journalRecords: 0, journalFiles: 0, stateFiles: [], tombstone: null }

  const step = (label, sql, params) => {
    try {
      const result = run(db, sql, params)
      dealt.rows += Number(result.changes) || 0
    } catch (cause) {
      failures.push(`${label}：${messageOf(cause)}`)
    }
  }

  // T8-3：与 inspect() 对齐——entityIds 收集必须带 workspace 过滤。之前这里只按
  // agent_id 过滤，清理单个 workspace 的 ghost 时会把同名 agent 在**其它 workspace**
  // 的活跃实体也删掉（体检和清理不一致的误删）。
  const entityIds = new Set(
    all(
      db,
      'SELECT entity_id FROM memory_entity WHERE agent_id = ? AND (? = \'\' OR workspace_id = ?)',
      [agentId, workspaceId, workspaceId],
    ).map((row) => String(row.entity_id)),
  )

  db.exec('BEGIN IMMEDIATE')
  try {
    for (const id of entityIds) {
      step('删版本', 'DELETE FROM memory_version WHERE entity_id = ?', [id])
    }
    // 逐表按实际列名拼条件：不同版本的表结构不完全一样，硬写列名会整批失败。
    for (const table of [
      'memory_entity',
      'pitfall',
      'quarantine',
      'persona_state',
      'persona_identity',
      'agent_skill',
      'session_policy',
      'audit_log',
      'distill_cursor',
    ]) {
      if (!tableExists(db, table)) continue
      const cols = tableColumns(db, table)
      if (!cols.includes('agent_id')) continue
      const conds = ['agent_id = ?']
      const params = [agentId]
      if (cols.includes('workspace_id') && workspaceId) {
        conds.push('workspace_id = ?')
        params.push(workspaceId)
      }
      step(`删 ${table}`, `DELETE FROM ${table} WHERE ${conds.join(' AND ')}`, params)
    }
    // 反向绑定：别的会话把这个人格当 persona_id 用，重放时会顺着它把人认回来。
    if (tableExists(db, 'persona_identity') && tableColumns(db, 'persona_identity').includes('persona_id')) {
      const conds = ['persona_id = ?']
      const params = [agentId]
      if (workspaceId) {
        conds.push('workspace_id = ?')
        params.push(workspaceId)
      }
      step('删反向人格绑定', `DELETE FROM persona_identity WHERE ${conds.join(' AND ')}`, params)
    }
    db.exec('COMMIT')
  } catch (cause) {
    try {
      db.exec('ROLLBACK')
    } catch {
      // 回滚也失败就交给下面的 failures 记录
    }
    failures.push(`事务失败：${messageOf(cause)}`)
  }

  if (options.journal) {
    for (const file of await listJournalFiles(root)) {
      if (file.device === 'purge') continue
      let text
      try {
        text = await readFile(file.path, 'utf8')
      } catch (cause) {
        failures.push(`读 journal 失败 ${file.path}：${messageOf(cause)}`)
        continue
      }
      const lines = parseLines(text)
      const kept = []
      let removed = 0
      for (const line of lines) {
        const rec = parseRecord(line)
        if (rec && belongsTo(rec, agentId, workspaceId, entityIds)) {
          removed++
          continue
        }
        kept.push(line)
      }
      if (removed === 0) continue
      try {
        await atomicReplace(file.path, kept.length > 0 ? `${kept.join('\n')}\n` : '')
        dealt.journalFiles++
        dealt.journalRecords += removed
      } catch (cause) {
        failures.push(`改写 journal 失败 ${file.path}：${messageOf(cause)}`)
      }
    }
  }

  // persona 文档
  if (report.personaFile) {
    try {
      await withRetry(() => unlink(report.personaFile))
    } catch (cause) {
      failures.push(`删 persona 文件失败：${messageOf(cause)}`)
    }
  }

  // state JSON
  for (const file of report.stateFiles) {
    try {
      await scrubStateFile(file, agentId, dealt)
    } catch (cause) {
      failures.push(`清洗状态文件失败 ${basename(file)}：${messageOf(cause)}`)
    }
  }

  // 墓碑最后写，且时间戳强制晚于已有墓碑：replay 按 (at, device, seq) 排序，
  // 如果新墓碑的时间戳更早，它会在 replay 顺序里排在"写回来"的记录之前 → 又活了。
  const prev = tombstones.get(agentId)
  const at = Math.max(Date.now(), (prev ? prev.at : 0) + 1)
  try {
    dealt.tombstone = await appendTombstone(root, workspaceId, agentId, at)
  } catch (cause) {
    failures.push(`写墓碑失败：${messageOf(cause)}`)
  }

  // 让 WAL 落盘，避免下次冷启动读到旧页
  try {
    db.exec('PRAGMA wal_checkpoint(TRUNCATE)')
  } catch {
    // 宿主还开着时必然失败，不致命
  }

  return { dealt, failures }
}

// ── 主流程 ─────────────────────────────────────────────────────────────────

async function main() {
  const options = parseArgs(process.argv.slice(2))
  const root = resolve(options.root)
  const dbFile = join(root, 'memory.db')

  if (!(await exists(dbFile))) fail(`找不到数据库：${dbFile}（用 --root 指定数据根）`)

  const tombstones = await readTombstones(root)
  let db = await openDb(dbFile, !options.apply)

  // 候选人：命令行指定 / 所有有墓碑的 agent
  let agentIds = options.agent ? [options.agent] : [...tombstones.keys()]
  if (agentIds.length === 0) {
    console.log('没有找到任何 agent.purge 墓碑，没什么可清的。')
    console.log(`（数据根：${root}）`)
    return 0
  }

  // workspace：指定 > 墓碑里带的 > 库中出现次数最多的
  const workspaceOf = (agentId) => {
    if (options.workspace) return options.workspace
    const tomb = tombstones.get(agentId)
    if (tomb && tomb.workspaceId) return tomb.workspaceId
    try {
      const rows = all(
        db,
        'SELECT workspace_id, COUNT(*) AS n FROM memory_entity WHERE agent_id = ? GROUP BY workspace_id ORDER BY n DESC LIMIT 1',
        [agentId],
      )
      return rows.length > 0 ? String(rows[0].workspace_id) : ''
    } catch {
      return ''
    }
  }

  const reports = []
  for (const agentId of agentIds) {
    const workspaceId = workspaceOf(agentId)
    reports.push(await inspect(db, root, options, agentId, workspaceId, tombstones))
  }

  const ghosts = reports.filter((report) => residualOf(report).length > 0)

  if (options.json) {
    console.log(JSON.stringify({ root, apply: options.apply, reports }, null, 2))
  } else {
    console.log(`数据根：${root}`)
    console.log(`模式：${options.apply ? '清理（--apply）' : '体检（只读，加 --apply 才动手）'}`)
    console.log(`墓碑 agent：${[...tombstones.keys()].join(', ') || '(无)'}`)
    console.log('')
    for (const report of reports) {
      const residual = residualOf(report)
      console.log(`── ${residual.length > 0 ? '幽灵（有残留）' : '干净'} ─────────────────────────────`)
      console.log(summarize(report))
      if (report.journal.records > 0 && !options.journal) {
        console.log('  注意：--no-journal 已开启，journal 正文不会删 → replay 仍可能复活')
      }
      console.log('')
    }
    if (ghosts.length === 0) {
      console.log('✔ 没有残留，不用清理。')
      return 0
    }
    if (!options.apply) {
      console.log(`要清理 ${ghosts.length} 个 agent，重跑并加 --apply：`)
      console.log(`  node scripts/clean-ghost.mjs --apply --root "${root}"`)
      return 0
    }
  }

  if (ghosts.length === 0) return 0

  if (options.apply && options.backup) {
    const dir = await backup(root)
    console.log(`备份完成：${dir}`)
  }

  let partial = false
  for (const report of ghosts) {
    console.log(`\n清理 ${report.agentId} …`)
    const { dealt, failures } = await applyClean(db, root, options, report, tombstones)
    console.log(
      `  库删除 ${dealt.rows} 行；journal 改写 ${dealt.journalFiles} 个文件 / 剔除 ${dealt.journalRecords} 条；` +
        `state 文件 ${dealt.stateFiles.length} 个；墓碑 ${dealt.tombstone ? `seq=${dealt.tombstone.seq} at=${dealt.tombstone.at}` : '未写入'}`,
    )
    for (const failure of failures) console.log(`  ⚠ ${failure}`)
    if (failures.length > 0 || !dealt.tombstone) partial = true
  }

  // 复检：换一个只读连接重新统计（避免读到自己的未提交状态/缓存）
  try {
    db.close?.()
  } catch {
    // ignore
  }
  db = await openDb(dbFile, true)
  const after = []
  for (const report of ghosts) {
    const fresh = await inspect(db, root, options, report.agentId, report.workspaceId, await readTombstones(root))
    after.push(fresh)
  }
  console.log('\n── 复检 ──────────────────────────────────')
  let remaining = 0
  for (const report of after) {
    const residual = residualOf(report)
    remaining += residual.length
    console.log(residual.length === 0 ? `✔ ${report.agentId} 已清干净` : `⚠ ${report.agentId} 仍有残留：${residual.join(' ')}`)
  }
  try {
    db.close?.()
  } catch {
    // ignore
  }

  if (remaining === 0) {
    console.log('\n✔ 完成。建议关掉 DSH 再重开一次，确认记忆没回来。')
    return 0
  }
  console.log('\n⚠ 有残留。若提示文件被占用（EBUSY/EPERM），先完全退出 DSH 再跑一次。')
  return partial || remaining > 0 ? 2 : 0
}

main()
  .then((code) => {
    process.exitCode = code
  })
  .catch((cause) => {
    // 这里兜住所有没预料到的异常：只打印，不抛。
    console.error(`✖ 清理失败：${messageOf(cause)}`)
    if (cause && cause.stack) console.error(cause.stack)
    process.exitCode = 1
  })
