/**
 * dsh-shared-memories — `node:sqlite` 驱动
 * ---------------------------------------------------------------------------
 * 为什么不用 better-sqlite3：DSH 运行时没有预编译二进制，装不上就等于插件装不上。
 * Node >= 22.5 自带 `node:sqlite`（`DatabaseSync`），API 与 better-sqlite3 一样
 * 是**同步**语义，正好符合 `SqlDriver` 的约定（时间树/检索层全部按同步写的）。
 *
 * 类型策略：`node:sqlite` 的类型声明随 Node 版本漂移，这里用本地最小接口描述它，
 * 避免 `@types/node` 版本差异导致 tsc 报错（导入路径用变量绕开静态解析）。
 */

import { mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import type { SqlDriver } from '../../shared/types.js'

/** `node:sqlite` 预处理语句的最小形状。 */
interface SqliteStatement {
  all(...params: unknown[]): unknown[]
  get(...params: unknown[]): unknown
  run(...params: unknown[]): { changes: number | bigint; lastInsertRowid: number | bigint }
}

/** `node:sqlite` 连接的最小形状。 */
interface SqliteDatabase {
  exec(sql: string): void
  prepare(sql: string): SqliteStatement
  close(): void
}

interface SqliteModule {
  DatabaseSync: new (path: string) => SqliteDatabase
  backup?: unknown
}

export class SqliteUnavailableError extends Error {
  readonly code = 'sqlite-unavailable'
  constructor(cause: unknown) {
    super(
      'node:sqlite 不可用：需要 Node >= 22.5（22.x 需 --experimental-sqlite）。' +
        `原始错误：${cause instanceof Error ? cause.message : String(cause)}`,
    )
    this.name = 'SqliteUnavailableError'
  }
}

/** 把 `node:sqlite` 的连接包成 `SqlDriver`（同步、事务同步）。 */
export class NodeSqliteDriver implements SqlDriver {
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
    const result = this.#db.prepare(sql).run(...params)
    return { changes: Number(result.changes) }
  }

  exec(sql: string): void {
    this.#db.exec(sql)
  }

  /**
   * 同步事务。用嵌套计数支持"事务里再调事务"（时间树的写入路径会出现），
   * 内层用 SAVEPOINT，异常时回滚到保存点，避免外层被误回滚。
   */
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
        if (depth > 0) this.#db.exec(`RELEASE ${savepoint}`)
      } catch {
        // 连接已失效时回滚也会失败，保留原始错误更有价值。
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
      // 重复关闭是幂等的。
    }
  }
}

/**
 * 打开（必要时创建）数据库文件。
 *
 * @param file 绝对路径；目录会自动创建
 */
export async function openSqliteDriver(file: string): Promise<SqlDriver> {
  let mod: SqliteModule
  try {
    // 变量化 specifier：避免 tsc 在旧 @types/node 上找不到 'node:sqlite' 声明。
    const specifier = 'node:sqlite'
    mod = (await import(specifier)) as unknown as SqliteModule
  } catch (error) {
    throw new SqliteUnavailableError(error)
  }
  if (typeof mod.DatabaseSync !== 'function') throw new SqliteUnavailableError('DatabaseSync 缺失')
  mkdirSync(dirname(file), { recursive: true })
  return new NodeSqliteDriver(new mod.DatabaseSync(file))
}
