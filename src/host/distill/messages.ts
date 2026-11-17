/**
 * 把宿主的消息/事件翻译成本插件自己的 `ChatTurn`。
 *
 * 为什么要这一层：宿主的 Message 是 LLM 形状（`content` 是一串 block），
 * 而事件流是另一套（`user/message` 的 data 本身就是 message，`assistant/message`
 * 藏在 `data.message` 里）。两种来源都要能喂给同一个 chunker，所以在这里抹平。
 */

import type { ChatRole, ChatTurn } from './chunker.js'

interface TextBlockLike {
  readonly type?: string
  readonly text?: string
}

function roleOf(value: unknown): ChatRole | undefined {
  switch (value) {
    case 'user':
      return 'user'
    case 'assistant':
      return 'assistant'
    case 'system':
    case 'developer':
      return 'system'
    case 'tool':
      return 'tool'
    default:
      return undefined
  }
}

/** 从一个 content 数组里抽纯文本（忽略图片/工具调用块，那些对"记忆"没意义）。 */
function textOf(content: unknown): string {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  const parts: string[] = []
  for (const block of content) {
    if (typeof block === 'string') {
      parts.push(block)
      continue
    }
    if (block === null || typeof block !== 'object') continue
    const typed = block as TextBlockLike
    if (typed.type !== undefined && typed.type !== 'text') continue
    if (typeof typed.text === 'string' && typed.text.trim() !== '') parts.push(typed.text)
  }
  return parts.join('\n')
}

interface MessageLike {
  readonly role?: unknown
  readonly content?: unknown
}

/** `session.deriveMessages()` 的结果。 */
export function messagesToTurns(messages: readonly unknown[]): ChatTurn[] {
  const turns: ChatTurn[] = []
  for (const raw of messages) {
    if (raw === null || typeof raw !== 'object') continue
    const message = raw as MessageLike
    const role = roleOf(message.role)
    if (role === undefined) continue
    const text = textOf(message.content).trim()
    if (text === '') continue
    turns.push({ role, text, seq: turns.length })
  }
  return turns
}

interface EventLike {
  readonly type?: unknown
  readonly seq?: unknown
  readonly data?: unknown
}

/** `ctx.sessionQuery.readSession(id).events` 或 `session.snapshotEvents()` 的结果。 */
export function eventsToTurns(events: readonly unknown[]): ChatTurn[] {
  const turns: ChatTurn[] = []
  for (const raw of events) {
    if (raw === null || typeof raw !== 'object') continue
    const event = raw as EventLike
    const type = typeof event.type === 'string' ? event.type : ''
    const data = event.data
    if (data === null || typeof data !== 'object') continue
    let message: unknown
    if (type === 'user/message' || type === 'system/message' || type === 'developer/message') {
      message = data
    } else if (type === 'assistant/message' || type === 'tool/result') {
      message = (data as { message?: unknown }).message
    } else {
      continue
    }
    if (message === null || typeof message !== 'object') continue
    const typed = message as MessageLike
    const role = roleOf(typed.role) ?? (type === 'user/message' ? 'user' : type === 'tool/result' ? 'tool' : 'assistant')
    const text = textOf(typed.content).trim()
    if (text === '') continue
    turns.push({ role, text, seq: typeof event.seq === 'number' ? event.seq : turns.length })
  }
  return turns
}
