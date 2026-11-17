/**
 * 对话 → 记忆 的转译管线（第一步：切块）。
 *
 * 为什么必须切块：一个长会话轻易几万 token，整段塞进 LLM 只会爆上下文，
 * 而且爆了以后拿到的是一句"抱歉"——比不提炼更糟（会误导后续召回）。
 * 所以固定走 Map-Reduce：chunk（这里）→ map（每块提炼）→ reduce（跨块归并）。
 */

export type ChatRole = 'user' | 'assistant' | 'system' | 'tool'

export interface ChatTurn {
  readonly role: ChatRole
  readonly text: string
  /** 会话内序号，用于 `source_seq_start/end` 与排障定位。 */
  readonly seq?: number
}

export interface Chunk {
  readonly index: number
  readonly turns: readonly ChatTurn[]
  /** 这块的字符数，用来避免"一块里塞了三条超长粘贴"。 */
  readonly chars: number
  /** 估算 token 数（见 estimateTokens），切块与预算判断都以它为准。 */
  readonly tokens: number
}

export interface ChunkOptions {
  /** 每块最多多少条消息，默认 20。 */
  readonly size?: number
  /** 每块最多多少字符，默认 6000；超了就提前断开（不影响下一块的完整性）。 */
  readonly maxChars?: number
  /** 每块最多多少估算 token，默认 1500（模型上下文的一块"安全垫"）。 */
  readonly maxTokens?: number
}

export const DEFAULT_CHUNK_SIZE = 20
export const DEFAULT_CHUNK_CHARS = 6000
export const DEFAULT_CHUNK_TOKENS = 1500

/**
 * 估算 token 数（不引分词器）。
 *
 * 口径：CJK 一个字 ≈ 1 token，其余字符 ≈ 4 字符 1 token —— 这是各家分词器
 * 在中文混排下的保守上界。切块只需要"别超预算"，宁高勿低：估多了只是多切一块，
 * 估少了就是整段 414/超长被模型拒掉。
 */
export function estimateTokens(text: string): number {
  let cjk = 0
  for (const ch of text) {
    const code = ch.codePointAt(0) ?? 0
    // CJK 统一表意文字、扩展 A、兼容区、全角标点与假名/谚文
    if (
      (code >= 0x3000 && code <= 0x303f) ||
      (code >= 0x3040 && code <= 0x30ff) ||
      (code >= 0x3400 && code <= 0x4dbf) ||
      (code >= 0x4e00 && code <= 0x9fff) ||
      (code >= 0xac00 && code <= 0xd7af) ||
      (code >= 0xf900 && code <= 0xfaff) ||
      (code >= 0xff00 && code <= 0xffef)
    ) {
      cjk++
    }
  }
  const rest = Math.max(0, text.length - cjk)
  return cjk + Math.ceil(rest / 4)
}

/** 按条数、字符数、token 数三重阈值切块：任一超限就开新块。 */
export function chunkTurns(turns: readonly ChatTurn[], options: ChunkOptions = {}): Chunk[] {
  const size = Math.max(1, options.size ?? DEFAULT_CHUNK_SIZE)
  const maxChars = Math.max(200, options.maxChars ?? DEFAULT_CHUNK_CHARS)
  const maxTokens = Math.max(64, options.maxTokens ?? DEFAULT_CHUNK_TOKENS)
  const chunks: Chunk[] = []
  let current: ChatTurn[] = []
  let chars = 0
  let tokens = 0

  const flush = (): void => {
    if (current.length === 0) return
    chunks.push({ index: chunks.length, turns: current, chars, tokens })
    current = []
    chars = 0
    tokens = 0
  }

  for (const turn of turns) {
    const text = turn.text.trim()
    if (text === '') continue
    const cost = estimateTokens(text)
    // 单条超长消息自己成块：硬拆会把一句话劈成两半，提炼出半截事实。
    if (current.length > 0 && (current.length >= size || chars + text.length > maxChars || tokens + cost > maxTokens)) flush()
    current.push({ ...turn, text })
    chars += text.length
    tokens += cost
  }
  flush()
  return chunks
}

/** 把一块渲染成给 LLM 的纯文本（保留角色边界，模型才分得清谁说的）。 */
export function renderChunk(chunk: Chunk): string {
  const label: Record<ChatRole, string> = {
    user: '用户',
    assistant: '助手',
    system: '系统',
    tool: '工具',
  }
  return chunk.turns.map((turn) => `[${label[turn.role]}] ${turn.text}`).join('\n')
}
