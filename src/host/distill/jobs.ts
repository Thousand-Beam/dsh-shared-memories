/**
 * 提炼任务的进度台账（进程内）。
 *
 * 为什么放在内存而不是数据库：进度是"这一次正在发生的事"，进程重启后它就没有意义了；
 * 落库反而会让 UI 重新打开时看到一个永远停在 37% 的僵尸任务。
 * 保留最近 20 个任务，够前端轮询与事后看结果。
 */

import type { DistillPhase, DistillReport } from './service.js'

export interface DistillJobView {
  readonly jobId: string
  readonly sessionId: string
  readonly mode: 'incremental' | 'deep'
  readonly status: 'running' | 'done' | 'failed' | 'skipped'
  readonly phase: DistillPhase
  readonly detail: string
  readonly chunk: number
  readonly total: number
  readonly turns: number
  readonly written: number
  readonly startedAt: number
  readonly updatedAt: number
  readonly error?: string
  readonly report?: DistillReport
}

export class DistillJobs {
  readonly #jobs = new Map<string, DistillJobView>()
  readonly #limit: number

  constructor(limit = 20) {
    this.#limit = Math.max(1, limit)
  }

  start(sessionId: string, mode: 'incremental' | 'deep', now = Date.now()): DistillJobView {
    const jobId = `dj_${now.toString(36)}_${Math.random().toString(36).slice(2, 8)}`
    const job: DistillJobView = {
      jobId,
      sessionId,
      mode,
      status: 'running',
      phase: 'reading',
      detail: '准备读取会话…',
      chunk: 0,
      total: 0,
      turns: 0,
      written: 0,
      startedAt: now,
      updatedAt: now,
    }
    this.#jobs.set(jobId, job)
    this.#trim()
    return job
  }

  progress(jobId: string, patch: Partial<Pick<DistillJobView, 'phase' | 'detail' | 'chunk' | 'total' | 'turns' | 'written'>>): void {
    const job = this.#jobs.get(jobId)
    if (job === undefined) return
    this.#jobs.set(jobId, { ...job, ...patch, updatedAt: Date.now() })
  }

  finish(jobId: string, report: DistillReport): void {
    const job = this.#jobs.get(jobId)
    if (job === undefined) return
    this.#jobs.set(jobId, {
      ...job,
      status: report.skipped !== undefined ? 'skipped' : 'done',
      phase: report.skipped !== undefined ? 'skipped' : 'done',
      detail:
        report.skipped === 'ephemeral'
          ? '无痕会话：没有写入任何记忆'
          : report.skipped === 'policy'
            ? '归档策略为「仅归档对话」：没有写入任何记忆'
            : report.skipped === 'empty'
              ? '这段会话没有可提炼的文本'
              : `已写入 ${report.written} 条记忆`,
      written: report.written,
      report,
      updatedAt: Date.now(),
    })
  }

  fail(jobId: string, error: unknown): void {
    const job = this.#jobs.get(jobId)
    if (job === undefined) return
    this.#jobs.set(jobId, {
      ...job,
      status: 'failed',
      phase: 'failed',
      detail: '提炼失败',
      error: error instanceof Error ? error.message : String(error),
      updatedAt: Date.now(),
    })
  }

  get(jobId: string): DistillJobView | undefined {
    return this.#jobs.get(jobId)
  }

  /** 前端没有 jobId 时用：给它看这个会话最近一次任务。 */
  latestFor(sessionId: string): DistillJobView | undefined {
    let latest: DistillJobView | undefined
    for (const job of this.#jobs.values()) {
      if (job.sessionId !== sessionId) continue
      if (latest === undefined || job.startedAt > latest.startedAt) latest = job
    }
    return latest
  }

  list(): DistillJobView[] {
    return [...this.#jobs.values()].sort((left, right) => right.startedAt - left.startedAt)
  }

  #trim(): void {
    if (this.#jobs.size <= this.#limit) return
    const sorted = [...this.#jobs.values()].sort((left, right) => left.startedAt - right.startedAt)
    for (const job of sorted.slice(0, this.#jobs.size - this.#limit)) this.#jobs.delete(job.jobId)
  }
}
