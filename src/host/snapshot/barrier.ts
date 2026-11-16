/**
 * dsh-shared-memories — 冷启动恢复闸门（Restore Barrier）
 * ---------------------------------------------------------------------------
 * PRD 1 的"强一致性"落地：
 *   **恢复没完成之前，不允许新对话开始。**
 *
 * 状态机（只允许图上这几条边，非法跳转直接抛错——静默容错只会把故障藏起来）：
 *
 *   cold ──> pulling ──> verifying ──> replaying ──> ready
 *     │          │            │             │
 *     │          └────────────┴─────────────┴──────> degraded
 *     └──> ready                      （纯本地模式：跳过所有网络阶段）
 *
 *   degraded ──> pulling            （用户点"重试"）
 *   ready    ──> pulling            （运行期再次拉取，例如设备从睡眠唤醒）
 *
 * `degraded` 的语义：**允许启动，但只读**。宁可让用户看到"你的记忆暂时只读"，
 * 也不要在数据没校验完的情况下静默写入，把本地好数据覆盖成脏数据。
 */

/** 恢复阶段。 */
export type RestorePhase =
  | 'cold'
  | 'pulling'
  | 'verifying'
  | 'replaying'
  | 'ready'
  | 'degraded'

/** 终态：不再自动向前推进。 */
const TERMINAL: ReadonlySet<RestorePhase> = new Set<RestorePhase>(['ready', 'degraded'])

/** 合法迁移表。 */
const LEGAL: Readonly<Record<RestorePhase, readonly RestorePhase[]>> = {
  cold: ['pulling', 'ready', 'degraded'],
  pulling: ['verifying', 'degraded'],
  verifying: ['replaying', 'degraded'],
  replaying: ['ready', 'degraded'],
  ready: ['pulling'],
  degraded: ['pulling'],
}

/** 非法状态迁移。 */
export class RestoreStateError extends Error {
  readonly code = 'restore-bad-transition'
  constructor(
    readonly from: RestorePhase,
    readonly to: RestorePhase,
  ) {
    super(`非法恢复状态迁移：${from} → ${to}`)
    this.name = 'RestoreStateError'
  }
}

/** 恢复未就绪就尝试写入时抛出。 */
export class RestoreBlockedError extends Error {
  readonly code = 'restore-blocked'
  constructor(
    readonly phase: RestorePhase,
    readonly operation: string,
  ) {
    super(`恢复未就绪（${phase}），拒绝写入操作：${operation}`)
    this.name = 'RestoreBlockedError'
  }
}

export interface RestoreTransitionEvent {
  readonly from: RestorePhase
  readonly to: RestorePhase
  /** 进入 degraded 的原因码；进入其他阶段时为 undefined。 */
  readonly reason?: string
  readonly detail?: unknown
  readonly at: number
}

export interface RestoreBarrierOptions {
  /** false = 只做提示不阻塞（不建议；PRD 要求默认 true）。 */
  readonly blockUntilReady?: boolean
  /** `wait()` 的最长阻塞时间；超时按降级处理，绝不无限挂起。 */
  readonly timeoutMs?: number
  readonly clock?: () => number
  readonly onTransition?: (event: RestoreTransitionEvent) => void
}

interface Waiter {
  resolve: (phase: RestorePhase) => void
  timer: ReturnType<typeof setTimeout> | undefined
}

export class RestoreBarrier {
  readonly #blockUntilReady: boolean
  readonly #timeoutMs: number
  readonly #clock: () => number
  readonly #onTransition: (event: RestoreTransitionEvent) => void

  #phase: RestorePhase = 'cold'
  #reason: string | undefined
  #detail: unknown
  #waiters: Waiter[] = []

  constructor(options: RestoreBarrierOptions = {}) {
    this.#blockUntilReady = options.blockUntilReady ?? true
    this.#timeoutMs = options.timeoutMs ?? 30_000
    this.#clock = options.clock ?? Date.now
    this.#onTransition = options.onTransition ?? (() => {})
  }

  get phase(): RestorePhase {
    return this.#phase
  }

  /** 进入 degraded 的原因码（如 `pull-failed`）；其他阶段为 undefined。 */
  get reason(): string | undefined {
    return this.#reason
  }

  get detail(): unknown {
    return this.#detail
  }

  /** 是否已经可以安全读写。 */
  get acceptsWrites(): boolean {
    return this.#phase === 'ready'
  }

  /** UI 用的只读标志：未就绪或已降级都算只读。 */
  get readOnly(): boolean {
    return !this.acceptsWrites
  }

  /** 是否处于终态（ready / degraded）。 */
  get settled(): boolean {
    return TERMINAL.has(this.#phase)
  }

  /** 推进状态；非法迁移抛 `RestoreStateError`。 */
  transition(to: RestorePhase, detail?: unknown, reason?: string): void {
    const from = this.#phase
    if (from === to) return
    if (!LEGAL[from].includes(to)) throw new RestoreStateError(from, to)
    this.#phase = to
    this.#reason = to === 'degraded' ? (reason ?? this.#reason ?? 'unknown') : undefined
    this.#detail = to === 'degraded' ? detail : undefined
    this.#onTransition({ from, to, reason: this.#reason, detail, at: this.#clock() })
    if (TERMINAL.has(to)) this.#settle(to)
  }

  /** 降级：只读可用，允许后续重试。 */
  fail(reason: string, detail?: unknown): void {
    if (this.#phase === 'degraded') {
      // 已经降级：只更新原因，不重复派发迁移事件。
      this.#reason = reason
      this.#detail = detail
      return
    }
    this.transition('degraded', detail, reason)
  }

  /** 恢复成功。 */
  markReady(): void {
    this.transition('ready')
  }

  /**
   * 阻塞闸门。
   *
   * - `blockUntilReady=false`：立刻返回当前阶段（只提示，不拦）。
   * - 已终态：立刻返回。
   * - 其他：挂起，直到 ready / degraded，或超时（超时按降级结算）。
   *
   * **永不 reject**：调用方（`agent/created`）需要的是"能不能继续"，而不是
   * 一个会让 agent 创建失败的异常。原因码通过 `phase`/`reason` 读取。
   */
  wait(): Promise<RestorePhase> {
    if (!this.#blockUntilReady) return Promise.resolve(this.#phase)
    if (TERMINAL.has(this.#phase)) return Promise.resolve(this.#phase)
    return new Promise<RestorePhase>((resolve) => {
      const waiter: Waiter = {
        resolve,
        timer:
          this.#timeoutMs > 0
            ? setTimeout(() => {
                // 超时 = 降级。移除自己再结算，避免 settle 时重复 resolve。
                this.#waiters = this.#waiters.filter((w) => w !== waiter)
                this.fail('restore-timeout', { afterMs: this.#timeoutMs, phase: this.#phase })
                resolve(this.#phase)
              }, this.#timeoutMs)
            : undefined,
      }
      if (waiter.timer && typeof waiter.timer === 'object' && 'unref' in waiter.timer) {
        // 不要让闸门自己拖住宿主进程退出。
        waiter.timer.unref()
      }
      this.#waiters.push(waiter)
    })
  }

  /** 写入前调用：未就绪直接抛 `RestoreBlockedError`。 */
  assertWritable(operation: string): void {
    if (!this.acceptsWrites) throw new RestoreBlockedError(this.#phase, operation)
  }

  /** 供测试/重启场景把闸门拨回 cold（不派发迁移事件以外的副作用）。 */
  reset(): void {
    this.#phase = 'cold'
    this.#reason = undefined
    this.#detail = undefined
  }

  #settle(phase: RestorePhase): void {
    const waiters = this.#waiters
    this.#waiters = []
    for (const waiter of waiters) {
      if (waiter.timer) clearTimeout(waiter.timer)
      waiter.resolve(phase)
    }
  }
}
