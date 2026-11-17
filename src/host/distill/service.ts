/**
 * 深度提炼（Map-Reduce）编排：会话全文 → 分块 → 每块提炼 → 跨块归并 → 写时间树。
 *
 * 三个"必须"：
 *   ① 必须走人格 id（persona_id）写入。否则人在 persona 视图下永远 0 条记忆——
 *      这就是真机上"聊了半天记忆还是空"的第二个原因。
 *   ② 必须尊重归档策略：无痕会话一条都不写；`off` 模式一条都不写。
 *   ③ 必须上报进度：深度重读可能几十秒，没有进度用户会以为卡死并杀进程，
 *      而杀在中途会留下"写了一半"的记忆。
 */

import type { SqlDriver } from '../../shared/types.js'
import type { EmotionLabel } from '../../shared/types.js'
import type { MemoryKind } from '../../shared/types.js'
import type { ArchiveMode } from '../../shared/session-policy.js'
import type { Scope } from '../../shared/scope.js'
import type { PoisonGuard } from '../memory/poison.js'
import type { SessionPolicyStore } from '../memory/session-policy.js'
import type { PersonaIdentityStore } from '../memory/persona-identity.js'
import type { TemporalTree } from '../memory/timetree.js'
import { chunkTurns, renderChunk, type ChatTurn, type ChunkOptions } from './chunker.js'
import {
  MAP_SYSTEM,
  REDUCE_SYSTEM,
  heuristicCandidates,
  mapPrompt,
  parseCandidates,
  reducePrompt,
  type DistillCandidate,
} from './extract.js'

/** 一次 LLM 补全：(system, user) → 纯文本。失败请抛，调用方会退回启发式。 */
export type Complete = (system: string, user: string) => Promise<string>

export type DistillPhase = 'reading' | 'distilling' | 'merging' | 'writing' | 'done' | 'skipped' | 'failed'

export interface DistillProgress {
  readonly phase: DistillPhase
  /** 给人看的一句话，UI 直接显示。 */
  readonly detail: string
  /** 当前第几块（1 起；未开始时 0）。 */
  readonly chunk: number
  readonly total: number
  readonly turns: number
  readonly written: number
}

export interface DistillRequest {
  readonly sessionId: string
  readonly turns: readonly ChatTurn[]
  /** `incremental` 只抽一遍；`deep` 会额外做跨块归并。 */
  readonly mode: Exclude<ArchiveMode, 'off'>
  readonly chunk?: ChunkOptions
  readonly onProgress?: (progress: DistillProgress) => void
}

export interface DistillReport {
  readonly sessionId: string
  readonly personaId: string
  readonly mode: ArchiveMode
  /** 非空表示这次没写任何东西，值为原因。 */
  readonly skipped?: 'ephemeral' | 'policy' | 'empty'
  readonly turns: number
  readonly chunks: number
  readonly candidates: number
  readonly written: number
  readonly usedLlm: boolean
  readonly durationMs: number
}

export interface DistillOptions {
  readonly db: SqlDriver
  readonly tree: TemporalTree
  readonly identity: PersonaIdentityStore
  readonly policies: SessionPolicyStore
  readonly workspaceId: string
  readonly deviceId: string
  readonly complete?: Complete
  readonly guard?: PoisonGuard
  readonly clock?: () => number
  readonly onWarn?: (message: string) => void
}

export class DistillService {
  readonly #db: SqlDriver
  readonly #tree: TemporalTree
  readonly #identity: PersonaIdentityStore
  readonly #policies: SessionPolicyStore
  readonly #workspaceId: string
  readonly #deviceId: string
  readonly #complete: Complete | undefined
  readonly #guard: PoisonGuard | undefined
  readonly #clock: () => number
  readonly #warn: (message: string) => void

  constructor(options: DistillOptions) {
    this.#db = options.db
    this.#tree = options.tree
    this.#identity = options.identity
    this.#policies = options.policies
    this.#workspaceId = options.workspaceId
    this.#deviceId = options.deviceId
    this.#complete = options.complete
    this.#guard = options.guard
    this.#clock = options.clock ?? (() => Date.now())
    this.#warn = options.onWarn ?? (() => undefined)
  }

  /**
   * 会话 id → 人格 id，并且**顺手把绑定登记掉**。
   *
   * 只读 `resolve()` 的问题：`persona_identity` 里没有这个会话的行时（插件装好前
   * 就存在的旧对话、没走 `agent/created` 的冷启动、脚本直接调 HTTP 触发提炼），
   * 它只能原样返回会话 id。那批记忆于是被写在一个"只出现过一次"的 agent 名下，
   * 而 UI / 提示词读的时候走的是解析后的锚点人格 —— 表现就是"提炼说写了 12 条，
   * persona 视图 0 条"。这就是从对话到记忆的落库断层。
   *
   * `touch()` 是幂等的：已有绑定原样返回（只更新 last_seen_at），没有则继承本工作区
   * 活跃人格，真正的新人格才自立门户；同时写 `persona.bind` 进 journal，换台机器
   * 重放后这条指针还在。
   */
  async #personaOf(sessionId: string): Promise<string> {
    try {
      return await this.#identity.touch(sessionId, this.#workspaceId)
    } catch (cause) {
      // 登记失败不能把整次提炼带走：退回只读解析，写库照常（此时退化为旧行为）。
      this.#warn(`人格登记失败，退回只读解析（${sessionId}）：${cause instanceof Error ? cause.message : String(cause)}`)
      return this.#identity.resolve(sessionId)
    }
  }

  /** 这个会话能不能写记忆。UI 也可以先问一句，避免点了按钮才被拒。 */
  async writable(sessionId: string): Promise<{ ok: boolean; reason?: 'ephemeral' | 'policy' }> {
    const ephemeral = await Promise.resolve(this.#policies.isEphemeral(sessionId))
    if (ephemeral) return { ok: false, reason: 'ephemeral' }
    const policy = this.#policies.get(sessionId, this.#workspaceId)
    if (policy.archiveMode === 'off') return { ok: false, reason: 'policy' }
    return { ok: true }
  }

  async run(request: DistillRequest): Promise<DistillReport> {
    const startedAt = this.#clock()
    const emit = (progress: DistillProgress): void => request.onProgress?.(progress)
    const turns = request.turns

    // ① 闸门必须排在登记之前。
    // 无痕会话一旦先走 `#personaOf()`，`touch()` 会写一行 persona_identity +
    // 一条 `persona.bind` journal 记录——那本身就是痕迹，"什么都不留"当场破功。
    // 所以顺序是：先查策略（一条主键查询，零副作用），不通过就纯读解析、直接返回。
    const gate = await this.writable(request.sessionId)
    if (!gate.ok) {
      const personaId = this.#identity.resolve(request.sessionId)
      emit({ phase: 'skipped', detail: gate.reason === 'ephemeral' ? '无痕会话：不写记忆' : '归档策略为「仅归档对话」：不写记忆', chunk: 0, total: 0, turns: turns.length, written: 0 })
      return {
        sessionId: request.sessionId,
        personaId,
        mode: request.mode,
        skipped: gate.reason,
        turns: turns.length,
        chunks: 0,
        candidates: 0,
        written: 0,
        usedLlm: false,
        durationMs: this.#clock() - startedAt,
      }
    }

    // ② 闸门通过才登记人格：落库断层的修法（纯读 → touch），此时写这一行是应该的。
    // 顺序反过来就是事故：无痕会话被顺手登记成一个人格，后面再"删"也删不干净。
    const personaId = await this.#personaOf(request.sessionId)

    const chunks = chunkTurns(turns, request.chunk)
    if (chunks.length === 0) {
      emit({ phase: 'skipped', detail: '这段会话没有可提炼的文本', chunk: 0, total: 0, turns: turns.length, written: 0 })
      return {
        sessionId: request.sessionId,
        personaId,
        mode: request.mode,
        skipped: 'empty',
        turns: turns.length,
        chunks: 0,
        candidates: 0,
        written: 0,
        usedLlm: false,
        durationMs: this.#clock() - startedAt,
      }
    }

    emit({ phase: 'reading', detail: `已读取 ${turns.length} 条消息，切成 ${chunks.length} 段`, chunk: 0, total: chunks.length, turns: turns.length, written: 0 })

    // ── Map ──
    const mapped: DistillCandidate[] = []
    let usedLlm = false
    for (const chunk of chunks) {
      emit({
        phase: 'distilling',
        detail: `正在提取第 ${chunk.index + 1}/${chunks.length} 段…`,
        chunk: chunk.index + 1,
        total: chunks.length,
        turns: turns.length,
        written: mapped.length,
      })
      const extracted = await this.#map(chunk, chunks.length)
      if (extracted.usedLlm) usedLlm = true
      mapped.push(...extracted.candidates)
    }

    // ── Reduce ──
    let final = mapped
    if (request.mode === 'deep' && mapped.length > 0) {
      emit({ phase: 'merging', detail: `正在归并 ${mapped.length} 条中间事实…`, chunk: chunks.length, total: chunks.length, turns: turns.length, written: mapped.length })
      final = await this.#reduce(mapped)
    }
    const deduped = dedupe(final)

    // ── Write ──
    const scope: Scope = { workspaceId: this.#workspaceId, agentId: personaId, deviceId: this.#deviceId }
    let written = 0
    for (const candidate of deduped) {
      emit({
        phase: 'writing',
        detail: `正在写入第 ${written + 1}/${deduped.length} 条记忆…`,
        chunk: chunks.length,
        total: chunks.length,
        turns: turns.length,
        written,
      })
      const accepted = await this.#accept(candidate, request.sessionId, scope)
      if (!accepted) continue
      try {
        await this.#tree.openVersion({
          scope,
          kind: candidate.kind as MemoryKind,
          subjectKey: candidate.subjectKey,
          text: candidate.text,
          ...(candidate.emotion
            ? { emotion: { label: candidate.emotion.label as EmotionLabel, intensity: candidate.emotion.intensity ?? 0.6, confidence: 0.7, subject: '', trigger: '' } }
            : {}),
          author: 'consolidator',
          trust: 0.55,
          distillStatus: 'distilled',
          distillModel: usedLlm ? 'llm' : 'heuristic',
        })
        written++
      } catch (cause) {
        this.#warn(`写记忆失败（${candidate.subjectKey}）：${cause instanceof Error ? cause.message : String(cause)}`)
      }
    }

    const report: DistillReport = {
      sessionId: request.sessionId,
      personaId,
      mode: request.mode,
      turns: turns.length,
      chunks: chunks.length,
      candidates: deduped.length,
      written,
      usedLlm,
      durationMs: this.#clock() - startedAt,
    }
    emit({
      phase: 'done',
      detail: written === 0 ? '没有抽取到值得长期记住的内容' : `已写入 ${written} 条记忆`,
      chunk: chunks.length,
      total: chunks.length,
      turns: turns.length,
      written,
    })
    return report
  }

  /** 单块提炼：优先 LLM，失败/为空退回启发式。 */
  async #map(chunk: { index: number; turns: readonly ChatTurn[] }, total: number): Promise<{ candidates: DistillCandidate[]; usedLlm: boolean }> {
    const text = renderChunk(chunk as never)
    if (this.#complete !== undefined) {
      try {
        const raw = await this.#complete(MAP_SYSTEM, mapPrompt(text, chunk.index, total))
        const parsed = parseCandidates(raw)
        if (parsed.length > 0) return { candidates: parsed, usedLlm: true }
      } catch (cause) {
        this.#warn(`LLM 提炼失败，退回规则抽取：${cause instanceof Error ? cause.message : String(cause)}`)
      }
    }
    return { candidates: heuristicCandidates(chunk.turns), usedLlm: false }
  }

  async #reduce(candidates: readonly DistillCandidate[]): Promise<DistillCandidate[]> {
    if (this.#complete === undefined) return dedupe(candidates)
    try {
      const raw = await this.#complete(REDUCE_SYSTEM, reducePrompt(candidates))
      const parsed = parseCandidates(raw, 12)
      return parsed.length > 0 ? parsed : dedupe(candidates)
    } catch (cause) {
      this.#warn(`归并失败，保留原始候选：${cause instanceof Error ? cause.message : String(cause)}`)
      return dedupe(candidates)
    }
  }

  /** 防投毒闸门：蒸馏结果也是"外部输入"，把它当 agent 来源过一遍。 */
  async #accept(candidate: DistillCandidate, sessionId: string, scope: Scope): Promise<boolean> {
    if (candidate.text.includes('\u0000')) return false
    if (this.#guard === undefined) return true
    try {
      const result = await this.#guard.guard({
        text: candidate.text,
        scope,
        kind: candidate.kind,
        source: 'agent',
        subjectKey: candidate.subjectKey,
      })
      if (result.assessment.action === 'quarantine') {
        this.#warn(`蒸馏结果进隔离区（${sessionId} / ${candidate.subjectKey}）：${result.assessment.reasons.join(',')}`)
        return false
      }
      return true
    } catch (cause) {
      this.#warn(`防投毒检查失败，放行：${cause instanceof Error ? cause.message : String(cause)}`)
      return true
    }
  }
}

/** 同 subjectKey + 同 kind 只留最长那条（最长 = 信息最全）。 */
export function dedupe(candidates: readonly DistillCandidate[]): DistillCandidate[] {
  const best = new Map<string, DistillCandidate>()
  for (const candidate of candidates) {
    const key = `${candidate.kind}::${candidate.subjectKey}`
    const existing = best.get(key)
    if (existing === undefined || candidate.text.length > existing.text.length) best.set(key, candidate)
  }
  return [...best.values()]
}
