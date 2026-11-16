/**
 * dsh-shared-memories — 用户画像（User Profile）
 * ---------------------------------------------------------------------------
 * 「你是谁」必须是一条**显式数据**，不能靠模型猜。
 *
 * 事故背景：没有这张表之前，模型会把仓库作者署名、git 提交者、设备名当成
 * 用户的名字，张口就叫错；换一个新会话更是彻底失忆——因为它记得的是 Agent 的
 * 人格，不是"坐在对面这个人叫什么"。
 *
 * 设计要点：
 *   1. **只按 workspace 维度存**（不是 agent）。用户是"这个项目里同一个人"，
 *      不是某个 Agent 的私有财产。跨 Agent 共享，跨工作区隔离。
 *   2. 它是一个四字段的小结构，不是开放式键值库：开放结构最后一定变成
 *      "什么都往里塞"，再也没法保证注入的提示是短而准的。
 *   3. 空画像不是错误：渲染时走"别猜，直接问"的兜底，而不是退回猜名字。
 */

/** 一个工作区里的用户画像。字段全为字符串，空串表示"未记录"。 */
export interface UserProfile {
  readonly workspaceId: string
  /** 用户的名字/全名，如「张三」。用于理解，不一定用于称呼。 */
  readonly displayName: string
  /** 希望被怎么称呼，如「老张」「小张」。**称呼优先用它**，没有再退回 displayName。 */
  readonly preferredAddress: string
  /** 一两句核心偏好（口味、时区、称呼禁忌等），保持短，别写成日记。 */
  readonly notes: string
  readonly updatedAt: number
  readonly updatedBy: string
}

/** 写入用输入：workspaceId 由调用方从 scope 补，不让前端传。 */
export interface UserProfileInput {
  readonly displayName?: string
  readonly preferredAddress?: string
  readonly notes?: string
}

export const EMPTY_PROFILE: Omit<UserProfile, 'workspaceId'> = {
  displayName: '',
  preferredAddress: '',
  notes: '',
  updatedAt: 0,
  updatedBy: '',
}

/** 单字段上限：画像是要进 System Prompt 的，长度必须可控。 */
export const PROFILE_FIELD_MAX = 200

/**
 * 归一化输入：去首尾空白、折叠内部换行、截断超长。
 *
 * 为什么要折叠换行：这个值会拼进提示的单行列表里，一旦能带 `\n`，
 * 就等于允许"往提示里插段落"——和技能名过正则同一个道理。
 */
export function normalizeProfileInput(input: UserProfileInput): UserProfileInput {
  const displayName = clean(input.displayName)
  const preferredAddress = clean(input.preferredAddress)
  return {
    // 界面上只有一个「怎么称呼我」：只传一个时另一侧自动取相同值，
    // 这样 `profileAddress()` 无论走哪条分支都拿得到同一个称呼。
    // 老数据里两者不同也没问题——读取侧永远优先 preferredAddress。
    displayName: displayName !== '' ? displayName : preferredAddress,
    preferredAddress: preferredAddress !== '' ? preferredAddress : displayName,
    notes: clean(input.notes),
  }
}

function clean(value: string | undefined): string {
  if (typeof value !== 'string') return ''
  return value
    .replace(/[\r\n\t]+/g, ' ')
    .replace(/\s{2,}/g, ' ')
    .trim()
    .slice(0, PROFILE_FIELD_MAX)
}

/** 有效的称呼：preferredAddress 优先，其次 displayName，都没有返回空串。 */
export function profileAddress(profile: UserProfile | undefined | null): string {
  if (!profile) return ''
  const preferred = profile.preferredAddress.trim()
  if (preferred !== '') return preferred
  return profile.displayName.trim()
}

/** 画像是否"有内容"（决定注入哪一支提示：真实画像 or 兜底）。 */
export function profileIsEmpty(profile: UserProfile | undefined | null): boolean {
  return profileAddress(profile) === '' && (profile?.notes.trim() ?? '') === ''
}
