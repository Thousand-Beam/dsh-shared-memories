/**
 * Map 阶段的提炼：把一块对话变成若干条"候选记忆"。
 *
 * 两条路并存，不是偷懒：
 *   ① 有 LLM → 用提示词让它输出严格 JSON（信息密度最高）；
 *   ② 没 LLM / LLM 失败 / JSON 坏了 → 走启发式规则（"必须/不要/记得/报错/我喜欢"）。
 * 第二条是**保底**：宁可抽得糙，也不能因为一次模型抽风就让整条管线 0 产出——
 * 用户看到的就是"聊了半天记忆还是 0 条"，这正是我们要修的 bug。
 */

import type { MemoryKind } from '../../shared/types.js'
import type { ChatTurn } from './chunker.js'

export interface DistillCandidate {
  readonly kind: MemoryKind
  readonly subjectKey: string
  readonly text: string
  readonly emotion?: { readonly label: string; readonly intensity?: number }
}

export const MAP_SYSTEM = [
  '你是一个记忆提炼器。用户会给你一段 AI 与用户的对话片段。',
  '你的任务是抽取「值得长期记住」的事实，不要复述整段对话。',
  '只输出 JSON 数组，不要解释、不要代码围栏。数组每一项形如：',
  '{"kind":"fact|preference|decision|pitfall|episode","subjectKey":"短横线小写词组","text":"一句话，第三人称，不超过 80 字","emotion":{"label":"joy|anxiety|frustration|pride|curiosity|anger|sadness|neutral","intensity":0到1}}',
  '规则：',
  '1. 只记用户明确表达过、或调试中确认过的结论；推测不要写。',
  '2. preference 记用户的稳定偏好；decision 记已定的方案；pitfall 记踩过的坑和正确做法。',
  '3. 一段对话最多 6 条；没有值得记的就输出 []。',
  '4. text 必须是完整句子，能被未来的自己在没有上下文时看懂。',
].join('\n')

export function mapPrompt(chunkText: string, index: number, total: number): string {
  return `这是第 ${index + 1}/${total} 段对话：\n\n${chunkText}\n\n请输出 JSON 数组。`
}

export const REDUCE_SYSTEM = [
  '你是一个记忆归并器。用户会给你若干条从同一场对话不同片段里抽出的记忆候选。',
  '请合并重复、丢掉过于琐碎的条目，输出 JSON 数组，格式与输入相同。',
  '保留最有复用价值的 8 条以内；同一条事实只留最完整的那条表述。',
].join('\n')

export function reducePrompt(candidates: readonly DistillCandidate[]): string {
  return JSON.stringify(candidates.map((item) => ({ kind: item.kind, subjectKey: item.subjectKey, text: item.text })))
}

const KINDS: readonly MemoryKind[] = ['fact', 'preference', 'decision', 'pitfall', 'persona', 'episode']
const EMOTIONS: readonly string[] = ['joy', 'anxiety', 'frustration', 'pride', 'curiosity', 'anger', 'sadness', 'neutral', 'fear', 'surprise', 'gratitude', 'loneliness']

function asKind(value: unknown): MemoryKind {
  return typeof value === 'string' && (KINDS as readonly string[]).includes(value) ? (value as MemoryKind) : 'fact'
}

/** 从模型输出里挖 JSON 数组：允许它带解释、带 ```json 围栏。 */
export function parseCandidates(raw: string, limit = 8): DistillCandidate[] {
  const text = raw.trim()
  if (text === '') return []
  const start = text.indexOf('[')
  const end = text.lastIndexOf(']')
  if (start < 0 || end <= start) return []
  let parsed: unknown
  try {
    parsed = JSON.parse(text.slice(start, end + 1))
  } catch {
    return []
  }
  if (!Array.isArray(parsed)) return []
  const out: DistillCandidate[] = []
  for (const item of parsed) {
    if (item === null || typeof item !== 'object') continue
    const record = item as Record<string, unknown>
    const body = typeof record.text === 'string' ? record.text.trim() : ''
    if (body === '') continue
    const subject = typeof record.subjectKey === 'string' && record.subjectKey.trim() !== '' ? record.subjectKey.trim() : slug(body)
    const emotionRaw = record.emotion
    let emotion: DistillCandidate['emotion']
    if (emotionRaw !== null && typeof emotionRaw === 'object') {
      const emo = emotionRaw as Record<string, unknown>
      const label = typeof emo.label === 'string' && EMOTIONS.includes(emo.label) ? emo.label : undefined
      if (label !== undefined) {
        const intensity = typeof emo.intensity === 'number' ? Math.min(1, Math.max(0, emo.intensity)) : 0.6
        emotion = { label, intensity }
      }
    }
    out.push({ kind: asKind(record.kind), subjectKey: subject, text: body.slice(0, 200), ...(emotion ? { emotion } : {}) })
    if (out.length >= limit) break
  }
  return out
}

/** 把一句中文压成稳定的 subjectKey（同一主题才能被时间树"切分"而不是"新开一条"）。 */
export function slug(text: string): string {
  const ascii = text
    .toLowerCase()
    .replace(/[^a-z0-9\u4e00-\u9fa5]+/g, '-')
    .replace(/^-+|-+$/g, '')
  const trimmed = ascii.slice(0, 40)
  return trimmed === '' ? 'note' : trimmed
}

interface Rule {
  readonly test: RegExp
  readonly kind: MemoryKind
  readonly emotion?: DistillCandidate['emotion']
}

const RULES: readonly Rule[] = [
  { test: /(报错|失败|踩坑|坑了|不生效|不能工作|抛异常|崩了)/, kind: 'pitfall', emotion: { label: 'frustration', intensity: 0.6 } },
  // 偏好排在"记住/必须"前面：用户说"记住，我爱吃鱼"时，preference 比 fact 有用。
  { test: /(喜欢|偏好|习惯|宁愿|更喜欢|受不了|爱吃|爱喝|不吃|不喝)/, kind: 'preference', emotion: { label: 'joy', intensity: 0.55 } },
  { test: /(记住|记一下|帮我记|备忘|留个记录)/, kind: 'fact' },
  { test: /(必须|一定要|务必|记得|别忘了|下次)/, kind: 'fact' },
  { test: /(不要|别把|避免|千万别)/, kind: 'pitfall' },
  { test: /(决定|就按|定了|采用|改成)/, kind: 'decision' },
]

/**
 * 助手的"收到式"回执：这类句子含"记下了""明白"，会被规则误当成事实抽走，
 * 于是记忆里长出一堆"好，记下了：清蒸鲈鱼"——真正该记的用户原话反而丢了。
 */
const ACK_ONLY = /^(好|好的|好嘞|明白|收到|了解|记下了|已记录|记住了|没问题|可以)[，,。！!：:\s]/

/**
 * 排版噪声：列表符号、序号、加粗、标题、引用。
 *
 * 这一条是被真机打出来的：助手回答里那句
 * `3. **再重复一次同一句偏好**（比如再说一遍「我爱吃鱼」）…`
 * 被规则命中后**原样**进了长期记忆，并且在召回段里重复了六遍。
 * 记忆要的是"用户说过的事实"，不是我们写给用户看的操作步骤。
 */
const LAYOUT_NOISE = /^\s*(?:[-*•#>]|\d+[.、)）])|\*\*|`{1,3}/

/** 元话语：讨论"记忆/插件/提示词本身"的句子，不是用户的事实。 */
const META_NOISE = /(记忆总览|召回段|上下文注入|提示词|prompt|Toast|reinforce_count|测试用例|断言|日志里|插件)/i

/** 去掉 markdown 修饰，只留能独立读懂的那句话。 */
function cleanup(line: string): string {
  return line
    .replace(/[*_`>#]/g, '')
    .replace(/^\s*(?:[-•]|\d+[.、)）])\s*/, '')
    .replace(/\s+/g, ' ')
    .trim()
}

function collect(
  turns: readonly ChatTurn[],
  roles: readonly string[],
  out: DistillCandidate[],
  seen: Set<string>,
  limit: number,
): void {
  for (const turn of turns) {
    if (!roles.includes(turn.role)) continue
    for (const rawLine of turn.text.split(/[\n。！？!?]/)) {
      const line = rawLine.trim()
      if (line.length < 8 || line.length > 160) continue
      // 排版与元话语一律不进记忆：宁可漏一条，也别让噪声占据注入预算。
      if (LAYOUT_NOISE.test(line)) continue
      if (META_NOISE.test(line)) continue
      if (turn.role === 'assistant' && ACK_ONLY.test(line)) continue
      const rule = RULES.find((candidate) => candidate.test.test(line))
      if (rule === undefined) continue
      const text = cleanup(line)
      if (text.length < 8) continue
      // 去重按"去掉标点空白后的字面"算：同一句话中间多一个逗号不该变成两条。
      const signature = text.replace(/[\s，,。.!！?？、；;：:]/g, '')
      if (seen.has(signature)) continue
      seen.add(signature)
      out.push({
        kind: rule.kind,
        subjectKey: slug(text),
        text,
        ...(rule.emotion ? { emotion: rule.emotion } : {}),
      })
      if (out.length >= limit) return
    }
  }
}

/** 无 LLM 时的兜底：按句式线索抽"用户说过的、能复用的话"。 */
export function heuristicCandidates(turns: readonly ChatTurn[], limit = 6): DistillCandidate[] {
  const out: DistillCandidate[] = []
  const seen = new Set<string>()
  // 用户的表达优先：他说的才是"事实源"，助手只是复述。
  collect(turns, ['user'], out, seen, limit)
  // 助手的话只在"没凑够"时补位，且已经被 ACK_ONLY / 排版噪声 / 元话语三重过滤。
  if (out.length < limit) collect(turns, ['assistant'], out, seen, limit)
  return out
}
