/**
 * 测试支撑：内存 SQLite 驱动 + 临时目录 + 故障注入
 * ---------------------------------------------------------------------------
 * 为什么不给测试单独写一份 DDL：那样"测试通过、线上炸"就是时间问题。
 * 这里直接复用 `src/host/storage/schema.ts` 的 `SCHEMA_SQL`，测的就是真实库结构。
 *
 * 数据库不可用（Node < 22.5 或没开 --experimental-sqlite）时，测试**跳过而不是失败**：
 * CI 应该红在真 bug 上，不该红在运行时版本上。
 */

import { mkdtemp, rm, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { TestContext } from 'node:test'
import { SCHEMA_SQL, SCHEMA_VERSION } from '../../src/host/storage/schema.js'
import type { SqlDriver } from '../../src/shared/types.js'

interface SqliteStatement {
  all(...params: unknown[]): unknown[]
  get(...params: unknown[]): unknown
  run(...params: unknown[]): { changes: number | bigint }
}

interface SqliteDatabase {
  exec(sql: string): void
  prepare(sql: string): SqliteStatement
  close(): void
}

/** 与生产同构的驱动（等价于 NodeSqliteDriver，但不依赖 lib 构建产物）。 */
class TestSqliteDriver implements SqlDriver {
  readonly #db: SqliteDatabase
  #depth = 0

  constructor(db: SqliteDatabase) {
    this.#db = db
  }

  all<T>(sql: string, params: readonly unknown[] = []): T[] {
    return this.#db.prepare(sql).all(...params) as T[]
  }

  one<T>(sql: string, params: readonly unknown[] = []): T | undefined {
    return this.#db.prepare(sql).get(...params) as T | undefined
  }

  run(sql: string, params: readonly unknown[] = []): { changes: number } {
    return { changes: Number(this.#db.prepare(sql).run(...params).changes) }
  }

  exec(sql: string): void {
    this.#db.exec(sql)
  }

  transaction<T>(fn: () => T): T {
    const depth = this.#depth++
    const savepoint = `sp_${depth}`
    this.#db.exec(depth === 0 ? 'BEGIN IMMEDIATE' : `SAVEPOINT ${savepoint}`)
    try {
      const result = fn()
      this.#db.exec(depth === 0 ? 'COMMIT' : `RELEASE ${savepoint}`)
      return result
    } catch (error) {
      try {
        this.#db.exec(depth === 0 ? 'ROLLBACK' : `ROLLBACK TO ${savepoint}`)
      } catch {
        // 忽略回滚二次失败
      }
      throw error
    } finally {
      this.#depth = depth
    }
  }

  close(): void {
    try {
      this.#db.close()
    } catch {
      // 幂等
    }
  }
}

let sqliteModule: { DatabaseSync: new (path: string) => SqliteDatabase } | undefined

async function loadSqlite(): Promise<{ DatabaseSync: new (path: string) => SqliteDatabase } | undefined> {
  if (sqliteModule) return sqliteModule
  try {
    const specifier = 'node:sqlite'
    const mod = (await import(specifier)) as unknown as { DatabaseSync?: unknown }
    if (typeof mod.DatabaseSync !== 'function') return undefined
    sqliteModule = mod as unknown as { DatabaseSync: new (path: string) => SqliteDatabase }
    return sqliteModule
  } catch {
    return undefined
  }
}

/**
 * 打开一个已建表的 `:memory:` 库。
 * 返回 undefined = 当前运行时没有 node:sqlite，调用方应 `t.skip()` 后 return。
 */
export async function openTestDb(t: TestContext): Promise<SqlDriver | undefined> {
  const mod = await loadSqlite()
  if (!mod) {
    t.skip('node:sqlite 不可用（需要 Node >= 22.5，22.x 需 --experimental-sqlite）')
    return undefined
  }
  const driver = new TestSqliteDriver(new mod.DatabaseSync(':memory:'))
  driver.exec(SCHEMA_SQL)
  driver.exec(`PRAGMA user_version = ${SCHEMA_VERSION}`)
  t.after(() => driver.close())
  return driver
}

/** 临时仓库目录，测试结束后自动清理。 */
export async function tempRoot(t: TestContext, prefix = 'shared-memories-'): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), prefix))
  t.after(async () => {
    await rm(dir, { recursive: true, force: true })
  })
  return dir
}

/**
 * 故障注入：把查询结果改坏，用来验证"结果集断言"这道防线。
 *
 * 真实场景是驱动的 cursor 返回了越界行（比如手写 SQL 漏了 WHERE），
 * 这里用装饰器模拟，测试断言 ScopedQuery 必须抛 `result-out-of-scope`。
 */
export function tamperRows(
  driver: SqlDriver,
  mutate: (row: Record<string, unknown>) => Record<string, unknown>,
): SqlDriver {
  return {
    all<T>(sql: string, params: readonly unknown[] = []): T[] {
      return driver.all<Record<string, unknown>>(sql, params).map(mutate) as T[]
    },
    one<T>(sql: string, params: readonly unknown[] = []): T | undefined {
      const row = driver.one<Record<string, unknown>>(sql, params)
      return row ? (mutate(row) as T) : undefined
    },
    run(sql: string, params: readonly unknown[] = []): { changes: number } {
      return driver.run(sql, params)
    },
    exec(sql: string): void {
      driver.exec(sql)
    },
    transaction<T>(fn: () => T): T {
      return driver.transaction(fn)
    },
  }
}

/** 读取测试输出的文件（不存在时返回空串，方便断言"日志到底写没写"）。 */
export async function readText(file: string): Promise<string> {
  try {
    return await readFile(file, 'utf8')
  } catch {
    return ''
  }
}

export async function writeText(file: string, content: string): Promise<void> {
  await writeFile(file, content, 'utf8')
}

/** 断言错误码：优先看 `code`，退化到 message 包含，避免实现细节一改测试就碎。 */
export function hasCode(error: unknown, code: string): boolean {
  if (!error || typeof error !== 'object') return false
  const candidate = (error as { code?: unknown }).code
  if (typeof candidate === 'string' && candidate === code) return true
  const message = (error as { message?: unknown }).message
  return typeof message === 'string' && message.includes(code)
}
