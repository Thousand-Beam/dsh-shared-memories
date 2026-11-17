/**
 * 提炼水位（distill cursor）。
 *
 * 为什么需要它：记忆原本只有一个写入入口 —— 归档（`workspace/session-stop`）。
 * 用户只是聊天、从不归档，于是 `memory_entity` 永远是 0 行，界面上就是
 * "什么都没记住"。要边聊边记，就必须知道"这段话提炼过没有"，否则每次
 * 触发都会把整段对话重写一遍，同一句偏好变成十几条重复条目。
 *
 * 水位按 turn 条数记（`readSessionTurns` 的顺序是 append-only 的），
 * 于是"新内容"=`turns.slice(水位)` —— 简单、幂等、不需要 diff。
 */
import type { SqlDriver } from '../../shared/types.js'

export interface DistillCursorOptions {
  db: SqlDriver
  clock?: () => number
  onWarn?: (message: string) => void
}

interface CursorRow {
  distilled_turns?: number
}

export class DistillCursor {
  readonly #db: SqlDriver
  readonly #clock: () => number
  readonly #onWarn: (message: string) => void

  constructor(options: DistillCursorOptions) {
    this.#db = options.db
    this.#clock = options.clock ?? (() => Date.now())
    this.#onWarn = options.onWarn ?? (() => {})
  }

  /** 已提炼到第几条 turn；没记过 = 0（整段都是新的）。 */
  get(sessionId: string): number {
    if (sessionId === '') return 0
    try {
      const row = this.#db.one<CursorRow>('SELECT distilled_turns FROM distill_cursor WHERE session_id = ?', [sessionId])
      const value = row?.distilled_turns
      return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : 0
    } catch (cause) {
      this.#onWarn(`读提炼水位失败（${sessionId}）：${cause instanceof Error ? cause.message : String(cause)}`)
      return 0
    }
  }

  /** 推进水位。只增不减：并发两路提炼时，晚到的那次不该把水位往回拨。 */
  set(sessionId: string, workspaceId: string, turns: number): void {
    if (sessionId === '' || !Number.isFinite(turns) || turns <= 0) return
    try {
      this.#db.run(
        `INSERT INTO distill_cursor (session_id, workspace_id, distilled_turns, updated_at)
         VALUES (?, ?, ?, ?)
         ON CONFLICT(session_id) DO UPDATE SET
           distilled_turns = MAX(distilled_turns, excluded.distilled_turns),
           workspace_id = excluded.workspace_id,
           updated_at = excluded.updated_at`,
        [sessionId, workspaceId, Math.floor(turns), this.#clock()],
      )
    } catch (cause) {
      this.#onWarn(`写提炼水位失败（${sessionId}）：${cause instanceof Error ? cause.message : String(cause)}`)
    }
  }

  /** 会话被销毁时一起清掉，避免"销毁后重开同名会话继承旧水位"。 */
  clear(sessionId: string): void {
    if (sessionId === '') return
    try {
      this.#db.run('DELETE FROM distill_cursor WHERE session_id = ?', [sessionId])
    } catch (cause) {
      this.#onWarn(`清提炼水位失败（${sessionId}）：${cause instanceof Error ? cause.message : String(cause)}`)
    }
  }
}
