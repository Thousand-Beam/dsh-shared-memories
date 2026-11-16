/**
 * dsh-shared-memories — 领域类型定义
 * ---------------------------------------------------------------------------
 * 这里只放「纯类型」，不放任何运行时代码，保证它被 lib 层与 client 层同时复用
 * 时不会把 node: 内建模块拖进浏览器包。
 *
 * 设计要点（对应 PRD 3/5/6/11）：
 *  - 记忆 = 实体（entity，跨版本稳定的身份） + 版本（version，时间树的一段区间）。
 *  - 情感归因不是自由文本，而是受 schema 约束的五个字段，写库前必须通过校验。
 *  - 每条记录都带 workspace_id / agent_id，它们是隔离的物理载体，而不是"约好要过滤"。
 */

/** 记忆种类。`episode` 是未蒸馏的会话摘要，`pitfall` 走四段式演进。 */
export type MemoryKind =
  | 'fact'
  | 'preference'
  | 'decision'
  | 'pitfall'
  | 'persona'
  | 'episode'

/**
 * 情感标签白名单。
 * 固定枚举而不是自由字符串，原因有二：
 *  1. 便于 UI 做统计与筛选（"最近焦虑的事"）；
 *  2. 蒸馏时模型无法用"复杂难言"之类的词逃避结构化约束。
 */
export type EmotionLabel =
  | 'joy'
  | 'anxiety'
  | 'frustration'
  | 'pride'
  | 'curiosity'
  | 'anger'
  | 'sadness'
  | 'neutral'

/**
 * 同一份枚举的运行时副本。
 *
 * 类型只活在编译期，而「隔离区洗白」「控制台改情感」这些入口拿到的是
 * 外部字符串——必须有可 `includes` 的白名单，否则 `label: string` 会被
 * 硬塞进 `EmotionLabel` 的位置（TS 拦得住，运行时拦不住 JSON）。
 */
export const EMOTION_LABELS = [
  'joy',
  'anxiety',
  'frustration',
  'pride',
  'curiosity',
  'anger',
  'sadness',
  'neutral',
] as const

export function isEmotionLabel(value: unknown): value is EmotionLabel {
  return typeof value === 'string' && (EMOTION_LABELS as readonly string[]).includes(value)
}

/** 蒸馏状态。`failed` 表示保留原文降级入库，绝不留空。 */
export type DistillStatus = 'raw' | 'distilled' | 'failed' | 'merged'/** 写入者。用于审计与污染防御（`importer` 默认低信任度）。 */
export type Author = 'user' | 'agent' | 'importer' | 'consolidator'

/** 实体生命周期。`forgotten` 是软删除，物理行保留以满足时间树可回溯。 */
export type EntityStatus = 'active' | 'merged' | 'quarantined' | 'forgotten'

/**
 * 结构化情感归因（PRD 6）。
 * 只有 `confidence >= 阈值` 才会被写入；否则整块置 null，宁可没有也不留幻觉。
 */
export interface EmotionAttribution {
  /** 谁产生/承受了这个情绪，如 "YG"、"agent"。 */
  readonly subject: string
  /** 因为什么事，如 "插件安装卡死 40 分钟"。 */
  readonly trigger: string
  readonly label: EmotionLabel
  /** 强度 0..1，用于 UI 的深浅着色。 */
  readonly intensity: number
  /** 模型自评置信度 0..1，低于闸门直接丢弃。 */
  readonly confidence: number
}

/** memory_entity 行（见 docs 中的 DDL）。 */
export interface EntityRow {
  entity_id: string
  workspace_id: string
  agent_id: string
  kind: MemoryKind
  subject_key: string
  canonical: string
  salience: number
  trust: number
  status: EntityStatus
  content_hash: string
  created_at: number
  updated_at: number
  device_id: string
}

/** memory_version 行，时间树的一段 [valid_from, valid_until)。 */
export interface VersionRow {
  version_id: string
  entity_id: string
  seq: number
  valid_from: number
  valid_until: number | null
  text: string
  emo_subject: string | null
  emo_trigger: string | null
  emo_label: EmotionLabel | null
  emo_intensity: number | null
  emo_confidence: number | null
  source_session_id: string | null
  source_seq_start: number | null
  source_seq_end: number | null
  distill_status: DistillStatus
  distill_model: string | null
  supersedes: string | null
  author: Author
  device_id: string
  created_at: number
}

/**
 * 最小 SQL 驱动器接口。
 *
 * 之所以自己定接口而不是直接依赖 better-sqlite3：
 *  - DSH 运行时优先用 `node:sqlite`（Node >= 22.5 内建，零原生编译）；
 *  - 用户机器上若不可用，降级到 JSONL + 内存索引的 `JsonDriver`；
 *  - 单测里用内存实现，不需要碰真文件系统。
 *
 * 语义约定与 better-sqlite3 一致：**同步执行**、`transaction` 内抛错整体回滚。
 * 异步只出现在「写 journal」这一侧，数据库本身不做异步，避免事务跨 await 断裂。
 */
export interface SqlDriver {
  all<T = Record<string, unknown>>(sql: string, params?: readonly unknown[]): T[]
  one<T = Record<string, unknown>>(sql: string, params?: readonly unknown[]): T | undefined
  run(sql: string, params?: readonly unknown[]): { changes: number }
  exec(sql: string): void
  transaction<T>(fn: () => T): T
}
