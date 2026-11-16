/**
 * dsh-shared-memories — Git 执行层
 * ---------------------------------------------------------------------------
 * 设计要点：
 *   1. **不用 shell 拼串**：一律 `execFile('git', args)`，参数数组直接下发，
 *      仓库路径/分支名里出现空格、`&&`、`$()` 也不会变成命令注入。
 *   2. **非零退出不抛**：统一返回 `{ code, stdout, stderr }`，由调用方决定
 *      "这次失败该重试、该降级还是该致命"，避免异常控制流满天飞。
 *   3. **一切都结构化**：`GitCommandError` 带 args / exitCode / stderr，
 *      上层可以直接把 stderr 塞进 UI 的 Toast，而不是丢一个 undefined。
 *   4. **强制超时**：网络操作（fetch/push）会挂很久，超时即杀掉子进程。
 */

import { execFile } from 'node:child_process'

export interface GitResult {
  readonly code: number
  readonly stdout: string
  readonly stderr: string
}

export interface GitRunOptions {
  /** 工作目录；缺省用 runner 自己的。 */
  readonly cwd?: string
  readonly timeoutMs?: number
  readonly env?: Readonly<Record<string, string>>
  /** 额外注入的 `-c key=value`（如 user.name / user.email）。 */
  readonly config?: Readonly<Record<string, string>>
}

export interface GitRunner {
  run(args: readonly string[], options?: GitRunOptions): Promise<GitResult>
}

/** 结构化 Git 错误：调用方可以按 `code` 做分支（`git-push-failed` 等）。 */
export class GitCommandError extends Error {
  constructor(
    readonly code: string,
    readonly args: readonly string[],
    readonly exitCode: number,
    readonly stderr: string,
    readonly stdout = '',
  ) {
    super(`git ${args.join(' ')} 失败（exit ${exitCode}）：${stderr.trim() || '无 stderr'}`)
    this.name = 'GitCommandError'
  }
}

/** 把 `GitResult` 转成"失败就抛"的形态，只用于必须成功的步骤。 */
export function assertGitOk(result: GitResult, args: readonly string[], code: string): GitResult {
  if (result.code !== 0) {
    throw new GitCommandError(code, args, result.code, result.stderr, result.stdout)
  }
  return result
}

/** 基于 `child_process.execFile` 的真实 runner（无 shell）。 */
export class ExecGitRunner implements GitRunner {
  readonly #cwd: string
  readonly #timeoutMs: number

  constructor(options: { cwd: string; timeoutMs?: number }) {
    this.#cwd = options.cwd
    this.#timeoutMs = options.timeoutMs ?? 30_000
  }

  run(args: readonly string[], options: GitRunOptions = {}): Promise<GitResult> {
    const configArgs: string[] = []
    for (const [key, value] of Object.entries(options.config ?? {})) {
      configArgs.push('-c', `${key}=${value}`)
    }
    const argv = [...configArgs, ...args]
    return new Promise<GitResult>((resolve) => {
      execFile(
        'git',
        argv,
        {
          cwd: options.cwd ?? this.#cwd,
          timeout: options.timeoutMs ?? this.#timeoutMs,
          windowsHide: true,
          maxBuffer: 8 * 1024 * 1024,
          env: { ...process.env, ...options.env, GIT_TERMINAL_PROMPT: '0' },
        },
        (error, stdout, stderr) => {
          if (!error) {
            resolve({ code: 0, stdout: String(stdout), stderr: String(stderr) })
            return
          }
          const code =
            typeof (error as { code?: unknown }).code === 'number'
              ? ((error as { code: number }).code as number)
              : 1
          resolve({ code, stdout: String(stdout ?? ''), stderr: String(stderr ?? error.message) })
        },
      )
    })
  }
}

/** 便于测试替换：内存 runner 记录所有调用。 */
export class RecordingGitRunner implements GitRunner {
  readonly calls: Array<{ args: readonly string[]; options?: GitRunOptions }> = []
  #handler: (args: readonly string[], options?: GitRunOptions) => GitResult | Promise<GitResult>

  constructor(handler: (args: readonly string[], options?: GitRunOptions) => GitResult | Promise<GitResult>) {
    this.#handler = handler
  }

  async run(args: readonly string[], options?: GitRunOptions): Promise<GitResult> {
    this.calls.push({ args, options })
    return this.#handler(args, options)
  }

  /** 测试里替换行为（例如"第一次 push 失败，第二次成功"）。 */
  setHandler(handler: (args: readonly string[], options?: GitRunOptions) => GitResult | Promise<GitResult>): void {
    this.#handler = handler
  }
}

/** 指数退避：`base * 2^attempt`，带 20% 抖动，避免多端同时重试打在同一秒。 */
export function backoffDelay(attempt: number, baseMs = 500, capMs = 30_000): number {
  const raw = Math.min(capMs, baseMs * 2 ** Math.max(0, attempt))
  const jitter = Math.floor(raw * 0.2 * Math.random())
  return raw + jitter
}

/** 可注入的 sleep，测试里替换成零延迟。 */
export type SleepFn = (ms: number) => Promise<void>

export const defaultSleep: SleepFn = (ms) =>
  new Promise<void>((resolve) => {
    const timer = setTimeout(resolve, ms)
    if (typeof timer === 'object' && 'unref' in timer) timer.unref()
  })
