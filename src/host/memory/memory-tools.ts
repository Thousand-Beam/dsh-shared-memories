/**
 * dsh-shared-memories — 模型可主动调用的记忆工具
 * ---------------------------------------------------------------------------
 * 竞品里"好用"的那几家（memento / dsh-memory / mneme）都有同一个特征：
 * **记忆是双向的** —— 除了自动召回，模型还能主动查、主动记。只有注入没有工具时，
 * 模型想确认"用户上次说的那个阈值是多少"就只能猜；猜错一次，用户对插件的信任就没了。
 *
 * 这里刻意只做四个工具（mnemon 的 17 个是反面教材：工具越多，模型选错的概率越高）：
 *   - `memory_search`   查：按当前问题召回，返回带 id 的条目；
 *   - `memory_remember` 记：模型判断"这条值得长期保存"时写一条；
 *   - `memory_forget`   忘：用户说"忘掉这个"时归档（软删，历史还在）；
 *   - `memory_stats`    看：库里有什么，用来回答"你都记得我什么"。
 *
 * 工具定义手写对象而不是 `defineTool`：插件运行时解析不到
 * `@deepseek-ai/dsh-tools` 的导出（它只存在于宿主 node_modules 里），
 * 而 `ctx.tools.register()` 只校验 `{name, output:{schema, render}}` 这三样。
 */

import type { MemoryKind, SqlDriver } from '../../shared/types.js'
import type { Scope } from '../../shared/scope.js'
import type { TemporalTree } from './timetree.js'
import type { PitfallStore } from './pitfall.js'
import type { PoisonGuard } from './poison.js'
import { recallMemories } from './recall.js'

/** 宿主 `ctx.tools` 的最小面。 */
export interface ToolRegistryLike {
  register(definition: unknown): unknown
}

export interface MemoryToolDeps {
  readonly workspaceId: string
  readonly deviceId?: string
  /** 取库；插件还没 boot 完时返回 undefined。 */
  readonly db: () => SqlDriver | undefined
  /** 取时间树；同上。 */
  readonly tree: () => TemporalTree | undefined
  /** 会话 → 人格 id（复用 persona_identity，不新开一套映射）。 */
  readonly personaOf: (sessionId: string) => string
  /** 踩坑链（四段式）；kind=pitfall 时同步写入，缺失则只写记忆不写链。 */
  readonly pitfalls?: () => PitfallStore | undefined
  /** 污染防御闸门；记忆主动写入前过一遍，缺失则不拦（但 trust 回落到 agent 基线）。 */
  readonly guard?: () => PoisonGuard | undefined
  /** 恢复闸门（degraded 只读承诺）：未就绪时拒写。 */
  readonly assertWritable?: (operation: string) => void
  readonly onWarn: (message: string) => void
}

const KINDS: readonly MemoryKind[] = ['fact', 'preference', 'decision', 'pitfall', 'persona', 'episode']

/** 模型侧执行上下文（只取我们用得到的两样）。 */
interface ToolExec {
  readonly agent?: { readonly session?: { readonly id?: string } }
}

const TEXT_OUTPUT = {
  schema: { type: 'string' },
  render: (_args: unknown, value: unknown) => [{ type: 'text', text: typeof value === 'string' ? value : JSON.stringify(value) }],
}

/**
 * 注册四个工具。返回卸载函数数组（宿主 `ctx.effect` 里统一回收）。
 *
 * 命名冲突处理：`memory_search` / `memory_forget` 与 dsh-memory 撞名，而
 * `tools.register()` 对重名是**直接抛错**（会让整个插件加载失败）。
 * 所以先试短名，失败再退到 `shared_memory_*` 前缀 —— 有别的记忆插件在场时，
 * 至少我们还能用，而不是大家一起挂。
 */
export function registerMemoryTools(
  registry: ToolRegistryLike | undefined,
  deps: MemoryToolDeps,
): Array<() => void> {
  if (registry === undefined || typeof registry.register !== 'function') {
    deps.onWarn('tools 服务不可用：记忆工具未注册（提示词召回仍然生效）')
    return []
  }

  const disposers: Array<() => void> = []

  const register = (short: string, definition: Record<string, unknown>): void => {
    for (const name of [short, `shared_${short}`]) {
      try {
        const disposer = registry.register({ ...definition, name })
        if (typeof disposer === 'function') disposers.push(disposer as () => void)
        return
      } catch (error) {
        // 只对"重名"退让；其它错误（schema 非法等）是 bug，必须暴露出来。
        const message = error instanceof Error ? error.message : String(error)
        if (!/duplicate|already|exists|taken/i.test(message)) {
          deps.onWarn(`注册工具 ${name} 失败：${message}`)
          return
        }
      }
    }
    deps.onWarn(`工具 ${short} 与其它插件重名且已回退到带前缀的名字仍失败，已跳过`)
  }

  const scopeOf = (exec: ToolExec | undefined): Scope | undefined => {
    const sessionId = exec?.agent?.session?.id
    if (typeof sessionId !== 'string' || sessionId === '') return undefined
    return { workspaceId: deps.workspaceId, agentId: deps.personaOf(sessionId), deviceId: deps.deviceId }
  }

  register('memory_search', {
    description:
      'Search long-term memory (facts, preferences, decisions, pitfalls, persona notes) for entries related to a query. ' +
      'Use it before answering anything about the user, their past requests, or earlier decisions in this workspace.',
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Natural-language query, usually the user\'s current sentence.' },
        limit: { type: 'number', description: 'Max entries to return (1-20, default 6).' },
      },
      required: ['query'],
      additionalProperties: false,
    },
    output: TEXT_OUTPUT,
    timeoutMs: 10_000,
    execute: async (args: { query?: unknown; limit?: unknown }, exec: ToolExec) => {
      const db = deps.db()
      const scope = scopeOf(exec)
      if (db === undefined || scope === undefined) return 'memory is not ready yet'
      const query = typeof args.query === 'string' ? args.query.trim() : ''
      if (query === '') return 'query 是空的：请给出要检索的关键词或问题'
      const limit = typeof args.limit === 'number' && Number.isFinite(args.limit) ? Math.min(20, Math.max(1, Math.trunc(args.limit))) : 6
      const hits = recallMemories(db, scope, query, { limit, budgetChars: 2000, minScore: 0.1 })
      if (hits.length === 0) return 'no matching memory'
      return hits
        .map((hit) => `[${hit.kind}] id=${hit.entityId} — ${hit.text}`)
        .join('\n')
    },
  })

  register('memory_remember', {
    description:
      'Store one durable memory about the user or this workspace. Use it when the user states a lasting preference, ' +
      'a fact about themselves, a decision, or a mistake worth never repeating. Do NOT store small talk or one-off requests.',
    parameters: {
      type: 'object',
      properties: {
        text: { type: 'string', description: 'One self-contained sentence in the user\'s language.' },
        kind: { type: 'string', enum: [...KINDS], description: 'Memory kind: fact (objective fact about the user/workspace), preference (what the user likes or wants), decision (a choice already made), pitfall (a mistake or trap worth never repeating — use this when the user or you hit an error/踩坑), persona (how to address the user). Default: preference for "I like X", otherwise fact.' },
        subject_key: { type: 'string', description: 'Short stable key for dedupe (e.g. "food/likes"). Optional.' },
      },
      required: ['text'],
      additionalProperties: false,
    },
    output: TEXT_OUTPUT,
    timeoutMs: 15_000,
    execute: async (args: { text?: unknown; kind?: unknown; subject_key?: unknown }, exec: ToolExec) => {
      const tree = deps.tree()
      const scope = scopeOf(exec)
      if (tree === undefined || scope === undefined) return JSON.stringify({ ok: false, error: 'memory is not ready yet' })
      const text = typeof args.text === 'string' ? args.text.trim() : ''
      if (text === '') return JSON.stringify({ ok: false, error: 'text is empty' })
      const kind = KINDS.includes(args.kind as MemoryKind) ? (args.kind as MemoryKind) : 'fact'
      const subjectKey =
        typeof args.subject_key === 'string' && args.subject_key.trim() !== ''
          ? args.subject_key.trim()
          : text.slice(0, 24)

      try {
        // 恢复闸门：degraded 只读时拒写（与 /memory、/import 等写路径一致）。
        deps.assertWritable?.('memory_remember')
        // 污染防御：模型主动记的当 agent 来源过闸门，不再伪装成 user 直写。
        // agent 基线信任 0.6（poison.ts DEFAULT_TRUST），过闸门后取评估值。
        let trust = 0.6
        const guard = deps.guard?.()
        if (guard !== undefined) {
          const guarded = await guard.guard({ text, scope, kind, source: 'agent', subjectKey })
          if (guarded.assessment.action === 'quarantine') {
            return JSON.stringify({
              ok: false,
              quarantined: true,
              reasons: guarded.assessment.reasons,
            })
          }
          trust = guarded.assessment.trust
        }
        const opened = await tree.openVersion({
          scope,
          kind,
          subjectKey,
          text,
          author: 'agent',
          trust,
          distillStatus: 'distilled',
          distillModel: 'model-tool',
        })
        // pitfall 记忆同步进四段式踩坑链（现象→经验→模式→规则），
        // 否则"记住错误"只会躺在 memory_entity 里，规则视图的"经验条目"永远是空的。
        let pitfall = false
        if (kind === 'pitfall') {
          const store = deps.pitfalls?.()
          if (store !== undefined) {
            try {
              await store.record({ scope, observation: text, author: 'agent' })
              pitfall = true
            } catch (error) {
              deps.onWarn(`踩坑链写入失败（记忆已保存，仅规则视图未同步）：${error instanceof Error ? error.message : String(error)}`)
            }
          }
        }
        return JSON.stringify({
          ok: true,
          entity_id: opened.entity.entity_id,
          kind,
          created: !opened.deduped,
          reinforced: opened.deduped,
          pitfall,
        })
      } catch (error) {
        deps.onWarn(`memory_remember 失败：${error instanceof Error ? error.message : String(error)}`)
        return JSON.stringify({ ok: false, error: 'write failed' })
      }
    },
  })

  register('memory_forget', {
    description:
      'Forget one memory by id (soft delete: the history row is kept, the entry stops being recalled). ' +
      'Use it when the user says to forget something. A missing id is not an error.',
    parameters: {
      type: 'object',
      properties: { entity_id: { type: 'string', description: 'Entity id returned by memory_search.' } },
      required: ['entity_id'],
      additionalProperties: false,
    },
    output: TEXT_OUTPUT,
    timeoutMs: 10_000,
    execute: async (args: { entity_id?: unknown }, exec: ToolExec) => {
      const db = deps.db()
      const tree = deps.tree()
      const scope = scopeOf(exec)
      const entityId = typeof args.entity_id === 'string' ? args.entity_id.trim() : ''
      if (db === undefined || tree === undefined || scope === undefined) return JSON.stringify({ ok: false, error: 'memory is not ready yet' })
      if (entityId === '') return JSON.stringify({ ok: false, error: 'entity_id is empty' })

      const owned = db.one<{ entity_id: string }>(
        'SELECT entity_id FROM memory_entity WHERE entity_id = ? AND workspace_id = ? AND agent_id = ?',
        [entityId, scope.workspaceId, scope.agentId],
      )
      // 删不存在的 id 返回成功（dsh-memory 的做法）：模型要的状态已经成立，
      // 报错只会引发一轮无意义的重试。
      if (owned === undefined) return JSON.stringify({ ok: true, forgotten: false })

      try {
        const active = db.one<{ valid_from: number }>(
          'SELECT valid_from FROM memory_version WHERE entity_id = ? AND valid_until IS NULL',
          [entityId],
        )
        const at = Math.max(Date.now(), (active?.valid_from ?? 0) + 1)
        await tree.closeAt(entityId, at, scope, 'user')
        db.run(
          `UPDATE memory_entity SET status = 'forgotten', updated_at = ? WHERE entity_id = ? AND workspace_id = ? AND agent_id = ?`,
          [Date.now(), entityId, scope.workspaceId, scope.agentId],
        )
        return JSON.stringify({ ok: true, forgotten: true })
      } catch (error) {
        deps.onWarn(`memory_forget 失败：${error instanceof Error ? error.message : String(error)}`)
        return JSON.stringify({ ok: false, error: 'forget failed' })
      }
    },
  })

  register('memory_stats', {
    description: 'Summarize what long-term memory currently holds for this workspace and agent (counts by kind, latest write).',
    parameters: { type: 'object', properties: {}, additionalProperties: false },
    output: TEXT_OUTPUT,
    timeoutMs: 5_000,
    execute: async (_args: unknown, exec: ToolExec) => {
      const db = deps.db()
      const scope = scopeOf(exec)
      if (db === undefined || scope === undefined) return 'memory is not ready yet'
      try {
        const rows = db.all<{ kind: string; n: number }>(
          `SELECT kind, COUNT(*) AS n FROM memory_entity
            WHERE workspace_id = ? AND agent_id = ? AND status = 'active'
            GROUP BY kind ORDER BY n DESC`,
          [scope.workspaceId, scope.agentId],
        )
        if (rows.length === 0) return 'memory is empty for this agent'
        const total = rows.reduce((sum, row) => sum + row.n, 0)
        const latest = db.one<{ updated_at: number }>(
          `SELECT MAX(updated_at) AS updated_at FROM memory_entity
            WHERE workspace_id = ? AND agent_id = ? AND status = 'active'`,
          [scope.workspaceId, scope.agentId],
        )
        const when = latest?.updated_at ? new Date(latest.updated_at).toISOString() : 'unknown'
        return `${total} entries (${rows.map((row) => `${row.kind}: ${row.n}`).join(', ')}), last update ${when}`
      } catch {
        return 'memory is not ready yet'
      }
    },
  })

  return disposers
}
