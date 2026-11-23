/**
 * dsh-shared-memories — 界面文案字典（client/i18n.ts）
 * ---------------------------------------------------------------------------
 * 一个硬规矩：**界面上不许出现英文枚举**。
 *
 * 后端（SQLite / HTTP DTO）里的 `fact`、`joy`、`quarantined` 是稳定的机器标识，
 * 该不该翻译不是风格问题——用户看到 `distillStatus: failed` 只会以为是插件坏了。
 * 所以所有枚举展示一律走这里的 `xxxLabel()`，视图层禁止直接把枚举值贴到 DOM：
 *
 *   ✗  <span>{card.kind}</span>
 *   ✓  <span>{kindLabel(card.kind)}</span>
 *
 * 字典之外的值不抛错、不显示 undefined，统一落到中文兜底（"其他"/"未标注"）：
 * 宿主以后新增一类 `memory_kind`，界面最多显示"其他"，不会裂成 `undefined`。
 */

/** 记忆类型：与 host 的 `MemoryKind` 一一对应。 */
export const KIND_LABEL: Record<string, string> = {
  fact: '事实',
  preference: '偏好',
  decision: '决策',
  pitfall: '踩坑',
  persona: '人格',
  episode: '片段',
  rule: '规则',
  skill: '技能',
  relation: '关系',
}

/** 情感标签：十二种基础情绪。 */
export const EMOTION_LABEL: Record<string, string> = {
  joy: '喜悦',
  anxiety: '焦虑',
  frustration: '挫败',
  pride: '自豪',
  curiosity: '好奇',
  anger: '愤怒',
  sadness: '难过',
  neutral: '平静',
  fear: '恐惧',
  surprise: '惊讶',
  gratitude: '感激',
  loneliness: '孤独',
}

/** 记忆生命周期状态。 */
export const STATUS_LABEL: Record<string, string> = {
  active: '生效中',
  merged: '已合并',
  quarantined: '已隔离',
  forgotten: '已淡忘',
}

/** 蒸馏（归档提炼）状态。 */
export const DISTILL_LABEL: Record<string, string> = {
  raw: '原始记录',
  distilled: '已提炼',
  failed: '提炼失败',
  merged: '已归并',
}

/** 快照触发原因。 */
export const TRIGGER_LABEL: Record<string, string> = {
  manual: '手动保存',
  shutdown: '关机落盘',
  interval: '定时快照',
  idle: '空闲快照',
  'pre-rollback': '回退前保护',
}

/** 冷启动恢复相位。 */
export const PHASE_LABEL: Record<string, string> = {
  cold: '冷启动',
  pulling: '拉取快照',
  verifying: '校验完整性',
  replaying: '重放记忆',
  ready: '已就绪',
  degraded: '只读降级',
}

/** 踩坑链阶段。 */
export const STAGE_LABEL: Record<string, string> = {
  observation: '现象',
  lesson: '经验',
  pattern: '模式',
  rule: '规则',
}

/**
 * 性格特质。内置的都是英文键（`curiosity` / `warmth` …），
 * 用户自建的特质（`trait7`、`话痨指数`）查不到就原样显示——那是数据，不是枚举。
 */
export const TRAIT_LABEL: Record<string, string> = {
  curiosity: '好奇',
  warmth: '温暖',
  rigor: '严谨',
  patience: '耐心',
  humor: '幽默',
  courage: '勇气',
  empathy: '共情',
  focus: '专注',
  creativity: '创造',
  honesty: '坦诚',
  independence: '独立',
  playfulness: '顽皮',
  optimism: '乐观',
  caution: '谨慎',
  assertiveness: '主见',
  adaptability: '应变',
}

/** 筛选器里固定出现的顺序（不按字典键序，字典会被人手改）。 */
export const KIND_ORDER = ['fact', 'preference', 'decision', 'pitfall', 'persona', 'episode'] as const
export const EMOTION_ORDER = [
  'joy',
  'anxiety',
  'frustration',
  'pride',
  'curiosity',
  'anger',
  'sadness',
  'neutral',
  'fear',
  'surprise',
  'gratitude',
  'loneliness',
] as const

function pick(dictionary: Record<string, string>, key: string | null | undefined, fallback: string): string {
  if (!key) return fallback
  return dictionary[key] ?? fallback
}

export const kindLabel = (key: string | null | undefined): string => pick(KIND_LABEL, key, '其他')
export const emotionLabel = (key: string | null | undefined): string => pick(EMOTION_LABEL, key, '未标注')
export const statusLabel = (key: string | null | undefined): string => pick(STATUS_LABEL, key, '未知状态')
export const distillLabel = (key: string | null | undefined): string => pick(DISTILL_LABEL, key, '未知')
export const triggerLabel = (key: string | null | undefined): string => pick(TRIGGER_LABEL, key, '未知来源')
export const phaseLabel = (key: string | null | undefined): string => pick(PHASE_LABEL, key, '未知相位')
export const stageLabel = (key: string | null | undefined): string => pick(STAGE_LABEL, key, '未分类')
export const traitLabel = (key: string): string => TRAIT_LABEL[key] ?? key

/**
 * 隔离原因。后端记的是机读码（有时大写、有时下划线），这里统一归一化再查表；
 * 查不到就原样回显——拦截原因是取证信息，宁可露出原码也不能编一个。
 */
export const REASON_LABEL: Record<string, string> = {
  'identity-override': '试图改写身份设定',
  'persona-deviation': '人格设定偏移',
  'baseline-breach': '触碰底线锁定项',
  'low-trust': '信任度低于阈值',
  'untrusted-source': '来源不可信',
  'scope-violation': '跨工作区写入',
  'injection-suspected': '疑似指令注入',
  'secret-leak': '疑似包含凭据',
  'duplicate-conflict': '与既有记忆冲突',
  'schema-invalid': '结构不合法',
}

export function reasonLabel(reason: string | null | undefined): string {
  if (!reason) return '未记录原因'
  const normalized = reason.trim().toLowerCase().replace(/_/g, '-')
  return REASON_LABEL[normalized] ?? reason
}
