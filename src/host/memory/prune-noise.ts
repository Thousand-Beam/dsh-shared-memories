/**
 * 噪声记忆自愈（host/memory/prune-noise.ts）
 * ---------------------------------------------------------------------------
 * 背景：启发式提炼曾经把**助手写给我们自己看的操作步骤**当成事实存进了长期记忆，
 * 于是注入段里出现了六行 `- (preference) 3. **再重复一次同一句偏好**…`。
 * 抽取规则已经修好（只认用户发言 + 过滤排版/元话语），但**已经写进库里的脏数据
 * 不会自己消失**，而且 journal 是 append-only 的真相源 —— 直接 DELETE 会在下次
 * 启动回放时原地复活。
 *
 * 所以这里做两件事，顺序不能反：
 *   ① 对每条噪声实体写一条 `memory.forget` 墓碑（进 journal，回放时同样生效）；
 *   ② 再把库里该实体置为 `forgotten`（下一次查询立刻看不到）。
 *
 * 判定**故意保守**：只有"带 markdown 排版"或"明显在讨论记忆机制本身"才动手，
 * 一条正常的"我爱吃清蒸鲈鱼"永远不会命中。
 */

import type { Journal } from '../../shared/journal.js'
import type { SqlDriver } from '../../shared/types.js'

/** 命中即判为噪声：返回原因，未命中返回 null。 */
export function noiseReason(text: string): string | null {
  const body = text.trim()
  if (body === '') return 'empty'
  // ①② 排版标记：记忆该是"一句话"，不是渲染后的列表项。
  if (/^\s*(?:[-*•#>]|\d+[.、)）])/.test(body)) return 'layout-list'
  if (body.includes('**') || body.includes('`')) return 'layout-markdown'
  // ③ 元话语：讨论"记忆机制/注入管线本身"的句子不是用户的事实。
  //    注意别把"插件"「prompt」这类**单独出现**的词也算进来——"项目是个 DSH 插件"
  //    是一条正经的项目记忆，误杀它比漏杀更难解释。
  if (/(记忆总览|召回段|reinforce_count|测试用例|断言|上下文注入|注入预算)/.test(body)) return 'meta'
  if (/(提示词|prompt|系统段).{0,12}(注入|组装|拼接|模板)/i.test(body)) return 'meta'
  // ④ 明显是"操作指令"的祈使句：再重复一次 / 然后看 / 请输出…
  if (/^(?:再|然后|请|记得把|不要忘)/.test(body)) return 'imperative'
  if (body.length > 200) return 'too-long'
  return null
}

export interface PruneNoiseOptions {
  readonly db: SqlDriver
  readonly journal?: Journal | undefined
  readonly clock?: (() => number) | undefined
  readonly workspaceId?: string | undefined
  readonly dryRun?: boolean | undefined
}

export interface PruneNoiseResult {
  readonly scanned: number
  readonly forgotten: number
  readonly reasons: Readonly<Record<string, number>>
}

/**
 * 扫描并遗忘噪声实体。幂等：第二次跑扫描到的都是 `status != 'active'` 的行。
 */
export async function pruneNoiseMemories(options: PruneNoiseOptions): Promise<PruneNoiseResult> {
  const { db, journal } = options
  const now = options.clock?.() ?? Date.now()
  // 只扫本工作区：不同 workspace 的噪声记忆不该被跨区清掉。
  const where = options.workspaceId !== undefined ? `status = 'active' AND workspace_id = ?` : `status = 'active'`
  const params: readonly unknown[] = options.workspaceId !== undefined ? [options.workspaceId] : []
  const rows = db.all<{ entity_id: string; canonical: string }>(
    `SELECT entity_id, canonical FROM memory_entity WHERE ${where}`,
    params,
  )

  const reasons: Record<string, number> = {}
  const targets: string[] = []
  for (const row of rows) {
    const reason = noiseReason(row.canonical)
    if (reason === null) continue
    reasons[reason] = (reasons[reason] ?? 0) + 1
    targets.push(row.entity_id)
  }

  if (options.dryRun === true || targets.length === 0) {
    return { scanned: rows.length, forgotten: 0, reasons }
  }

  // 先写墓碑再改库：即便中途断电，回放也能把这条记忆重新标成 forgotten。
  let forgotten = 0
  for (const entityId of targets) {
    try {
      await journal?.append({ op: 'memory.forget', entityId, at: now, reason: 'noise-prune' })
    } catch {
      // 墓碑写失败就跳过这条：只在库里标死、回放时复活，比"假装成功"更糟。
      continue
    }
    db.run(`UPDATE memory_entity SET status = 'forgotten', updated_at = ? WHERE entity_id = ?`, [now, entityId])
    forgotten++
  }

  return { scanned: rows.length, forgotten, reasons }
}
