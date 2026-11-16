/**
 * dsh-shared-memories — ID / 哈希 / 文本归一化
 * ---------------------------------------------------------------------------
 * 三条硬要求：
 *  1. ID 必须**可排序**：快照回放、冲突合并都依赖"谁先谁后"，UUIDv4 做不到。
 *  2. 哈希必须**跨设备一致**：同一句话在两台机器上要算出同一个指纹，否则去重失效。
 *  3. 文本归一化必须**保守**：只做 Unicode NFC + 空白折叠，绝不改大小写或标点，
 *     否则中文/代码片段会被"归一"成另一个意思。
 */
import { createHash, randomBytes } from 'node:crypto'

/** Crockford Base32，去掉 I/L/O/U，避免人工转录歧义。 */
const ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ'

/** 把整数按 base32 编码成定长字符串（时间戳部分用）。 */
function encodeBase32(value: number, length: number): string {
  let out = ''
  let n = value
  for (let i = 0; i < length; i++) {
    out = ALPHABET[n % 32]! + out
    n = Math.floor(n / 32)
  }
  return out
}

/**
 * 生成 ULID 风格的有序 ID：`<prefix>_<10位时间><16位随机>`。
 * 同一毫秒内的大量写入靠随机段保持唯一；跨毫秒则天然按时间递增，
 * 这让 journal 的 `seq` 排序与 `ORDER BY version_id` 的结果保持一致。
 */
export function newId(prefix = 'id'): string {
  const now = Date.now()
  const time = encodeBase32(now, 10)
  const rand = Array.from(randomBytes(10), (byte) => ALPHABET[byte % 32]).join('')
  return `${prefix}_${time}${rand}`
}

/** sha256 十六进制串，统一小写输出。 */
export function sha256Hex(input: string | Uint8Array): string {
  return createHash('sha256').update(input).digest('hex')
}

/**
 * 用于身份指纹的文本归一化：NFC + 折叠所有空白为单个空格 + 去首尾空白。
 * 注意**不做** lowercase：`React` 与 `react` 在技术记忆里可能是两个实体。
 */
export function normalizeForHash(text: string): string {
  return text.normalize('NFC').replace(/\s+/gu, ' ').trim()
}

/**
 * 实体身份指纹。
 *
 * 口径很关键：**不含正文**。实体代表"这条记忆说的是什么对象"
 * （如 `project:dsh-shared-memories` 的"同步策略"），正文变化只产生新版本，
 * 不产生新实体。正文级的去重由 `TemporalTree` 比对活跃版本文本完成。
 */
export function identityHash(parts: {
  workspaceId: string
  agentId: string
  kind: string
  subjectKey: string
}): string {
  return sha256Hex(
    [parts.workspaceId, parts.agentId, parts.kind, normalizeForHash(parts.subjectKey)].join('\u0000'),
  )
}
