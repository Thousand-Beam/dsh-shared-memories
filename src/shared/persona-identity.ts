/**
 * 会话身份与人格身份的分层。
 *
 * 背景（真机事故）：DSH 里 `agent.id === agent.session.id`，也就是**一个会话就是一个
 * Agent**。用户点一次「新建会话」，宿主就发一个全新的 agent id；而人格（persona_state）
 * 与记忆（memory_entity）都是按 agent_id 存的。结果就是：
 *
 * - 上一轮把人格改名成「翟千瑶」；
 * - 下一次新建会话，agent_id 变了 → 读不到 persona_state → 模型退回默认自称；
 * - 控制台顶部下拉是按 persona_state 列的，所以还能看到旧名字，但列表查的是新 id → 0 条。
 *
 * 修法不是"把记忆表的 agent_id 改成 workspace 级"（那会丢掉多 Agent 隔离），
 * 而是加一层**指针**：`agent_id → persona_id`。
 *
 * - `agentId`   本次会话的 id，一次性，会一直变；
 * - `personaId` 稳定人格 id，等于这个工作区里**第一个**登记的那个会话 id；
 * - 后开的所有会话都绑到同一个 persona_id，于是人格、记忆、技能、隔离区一起继承。
 *
 * 想真正并行两个不同人格时，用 `bindTo(agentId, personaId, 'user')` 显式改绑即可。
 */

/** 一条会话 → 人格的绑定。 */
export interface PersonaIdentity {
  /** 本次会话的 agent id（会变）。 */
  readonly agentId: string
  /** 所属工作区。 */
  readonly workspaceId: string
  /** 稳定人格 id（= 首个会话 id，之后不再变化）。 */
  readonly personaId: string
  /** 首次绑定时间。 */
  readonly boundAt: number
  /** 最近一次出现时间：用于挑"这个工作区最近在用的人格"。 */
  readonly lastSeenAt: number
}

/** 绑定是谁做的。`auto` = 新会话自动继承；`user` = 界面上手动改绑。 */
export type PersonaBindSource = 'auto' | 'user' | 'snapshot'

/** 一个工作区里的人格，带它下面挂着的会话数。 */
export interface PersonaSummary {
  readonly personaId: string
  readonly workspaceId: string
  readonly sessionCount: number
  readonly lastSeenAt: number
}

/**
 * 判断某个 id 是否"看起来像一次性会话 id"。
 *
 * 宿主给的是 `session-<uuid>` 这种形状；人格 id 早期可能直接是普通名字（`lead`）。
 * 只用于 UI 上的提示文案（"这个 Agent 是 X 个会话共用的"），不参与任何隔离判断。
 */
export function looksLikeSessionId(agentId: string): boolean {
  return /^session[-_:]/i.test(agentId) || /^[0-9a-f]{8}-[0-9a-f]{4}-/i.test(agentId)
}
