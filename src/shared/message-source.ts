/**
 * dsh-shared-memories — v4 消息来源声明（shared/message-source.ts）
 * ---------------------------------------------------------------------------
 * 宿主 v4 消息格式的硬约束：**任何**注入到上下文的 message / prompt，
 * 其 `source.kind` 必须是"生产者持有"的形式 `plugin:<插件名>`，
 * 写成旧版裸 `"plugin"`（或任何别的值）会被宿主直接打回：
 *
 *     format v4 message requires a producer-owned source kind
 *
 * 所以这个常量不许散落在各处手写字符串——统一从这里取，
 * 想改插件名就改 `PLUGIN_ID` 一处，所有注入点跟着变。
 */

/** 插件标识；必须与 `package.json` 的 name 以及客户端 `export const name` 一致。 */
export const PLUGIN_ID = 'dsh-shared-memories'

/** v4 规定的生产者来源类型：`plugin:<插件名>`。 */
export const PRODUCER_SOURCE_KIND = `plugin:${PLUGIN_ID}` as const

export type ProducerSourceKind = typeof PRODUCER_SOURCE_KIND

/** 宿主要求的 source 结构（只声明我们真正用到的字段）。 */
export interface PluginMessageSource {
  kind: ProducerSourceKind
  /** 冗余写上插件名：宿主日志与审计按它归因。 */
  plugin: string
}

/** 造一个合法的 source 对象。**所有**注入点都必须用它，不要手写字面量。 */
export function pluginSource(): PluginMessageSource {
  return { kind: PRODUCER_SOURCE_KIND, plugin: PLUGIN_ID }
}

export function isProducerSourceKind(value: unknown): value is ProducerSourceKind {
  return value === PRODUCER_SOURCE_KIND
}

/**
 * 断言一条待注入消息的来源合法。放在注入前一步调用，
 * 让错误在插件侧就炸出来（带上下文），而不是等宿主在格式化阶段抛。
 */
export function assertProducerSource(message: { source?: { kind?: unknown } | undefined }): void {
  const kind = message.source?.kind
  if (!isProducerSourceKind(kind)) {
    throw new Error(
      `format v4 message requires a producer-owned source kind (expected "${PRODUCER_SOURCE_KIND}", got ${JSON.stringify(kind)})`,
    )
  }
}

/** 就地补上合法 source 并返回同一条消息，方便在 `arr.map(...)` 里串起来。 */
export function withProducerSource<T extends { source?: { kind?: unknown } }>(message: T): T {
  message.source = pluginSource()
  return message
}
