/**
 * dsh-shared-memories — 恢复引擎
 * ---------------------------------------------------------------------------
 * "开机即还原" 的读半边。顺序不能改：
 *
 *   pull（ff-only） → 校验 manifest 逐文件 sha256 → 校验 schema 版本
 *   → 按事件时间回放 journal → PRAGMA integrity_check → ready
 *
 * 任何一步失败 → `degraded`（只读 + 允许重试）。**绝不静默启动**：
 * 半个快照灌进时间树比直接报错危险一万倍，因为用户会以为"记忆在，只是少了点"。
 */

import { readdir, readFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import type { SqlDriver } from '../../shared/types.js'
import type { Journal, JournalRecord } from '../../shared/journal.js'
import { readSchemaVersion, migrate, SCHEMA_VERSION } from '../storage/schema.js'
import { RestoreBarrier, type RestorePhase } from './barrier.js'
import { assertGitOk, backoffDelay, defaultSleep, type GitRunner, type SleepFn } from './git.js'
import { readManifest, snapshotIdOf } from './manifest.js'
import { rehydratePersonaFromRepo } from '../prompt/persona-rehydrate.js'
import { rehydrateSkillsFromRepo } from '../prompt/skill-rehydrate.js'
import { rehydrateUserProfilesFromRepo } from '../prompt/user-profile-rehydrate.js'
import { rehydratePersonaIdentitiesFromRepo } from '../prompt/persona-identity-rehydrate.js'
import { createHash } from 'node:crypto'

/** 结构化恢复错误：`code` 直接映射成 UI 上的原因。 */
export class RestoreError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly detail?: unknown,
  ) {
    super(message)
    this.name = 'RestoreError'
  }
}

export interface RestoreOutcome {
  readonly status: 'ready' | 'degraded'
  readonly phase: RestorePhase
  readonly code?: string
  readonly snapshotId?: string
  readonly files?: number
  readonly records?: number
  readonly error?: unknown
}

export interface RestoreEngineOptions {
  readonly root: string
  readonly db: SqlDriver
  readonly journal: Journal
  readonly barrier: RestoreBarrier
  readonly git: GitRunner
  readonly remote?: string
  readonly branch?: string
  readonly pullStrategy?: 'ff-only' | 'rebase'
  readonly offlinePolicy?: 'degraded-readonly' | 'local-only' | 'block'
  readonly timeoutMs?: number
  readonly retries?: number
  readonly onWarn?: (message: string) => void
  readonly sleep?: SleepFn
  /** 校验快照哈希时是否允许"没有快照"（全新设备首次启动）。 */
  readonly allowMissingSnapshot?: boolean
}

interface ReplayStats {
  records: number
  entities: number
  versions: number
  closed: number
  forgotten: number
  emotions: number
  quarantined: number
  skills: number
  userProfiles: number
  personaIdentities: number
  personas: number
  purged: number
  deferred: number
  skipped: number
}

/**
 * journal → SQLite 的回放器。
 *
 * 幂等性来源：`INSERT ... ON CONFLICT DO UPDATE` + `valid_until` 直接覆盖。
 * 所以同一个快照回放两次、或者两台设备合并后重复回放，都不会产生脏数据。
 */
export class ReplayApplier {
  readonly #db: SqlDriver

  constructor(db: SqlDriver) {
    this.#db = db
  }

  apply(records: readonly JournalRecord[]): ReplayStats {
    const stats: ReplayStats = {
      records: 0,
      entities: 0,
      versions: 0,
      closed: 0,
      forgotten: 0,
      emotions: 0,
      quarantined: 0,
      skills: 0,
      userProfiles: 0,
      personaIdentities: 0,
      personas: 0,
      purged: 0,
      deferred: 0,
      skipped: 0,
    }
    // v0.4.2 墓碑语义（销毁优先 + 可重建）：按 lc 顺序重放时动态跟踪每个
    // (workspaceId, agentId) 的「当前是否已销毁」。agent.purge 置位；之后若出现新的
    // persona.bind（同名重建），撤销墓碑。
    //
    // 为什么不能像 v0.4.1 那样「预扫最大墓碑 lc + 无条件跳过 lc>墓碑」：
    //   1. 守卫不对称——version.open / close / emotion 没挂守卫，销毁后重建的记忆
    //      journal 是 [entity.upsert(被跳过) → version.open(照常执行)]，version.open 往
    //      不存在的实体下插版本 → 外键炸 → 整个事务回滚 → degraded 只读（评价 1/2
    //      实测 P0-2，本机重启同样中招）。
    //   2. 语义自相矛盾——无条件跳过等于宣布「销毁过的 agentId 永不复用」，与
    //      KNOWN-ISSUES #1「purge 后 realignClock 保护本机新写入」相反。
    // 状态机式重放同时满足两条：销毁前的并发残留写（lc>purge 且无重建信号）被跳过，
    // 销毁后的同名重建（有 persona.bind 重新武装）正常落库、不炸外键。
    const purged = new Map<string, number>()
    const isPurged = (ws: string | undefined, aid: string | undefined, lc: number): boolean => {
      if (ws === undefined || aid === undefined) return false
      const plc = purged.get(`${ws}\u0000${aid}`)
      return plc !== undefined && lc > plc
    }

    this.#db.transaction(() => {
      for (const record of records) {
        stats.records++
        switch (record.op) {
          case 'entity.upsert': {
            // 墓碑优先：销毁之后残留的并发写跳过，否则已销毁 agent 复活（评价一/三）。
            if (isPurged(str(record.workspaceId), str(record.agentId), num(record.lc) ?? 0)) {
              stats.skipped++
              break
            }
            this.#upsertEntity(record)
            stats.entities++
            break
          }
          case 'version.open': {
            // 对称守卫（P0-② 修复）：销毁后残留的 version.open 若照常执行，会在
            // 「实体已被 entity.upsert 跳过」的情况下往不存在的实体下插版本 → 外键
            // 炸 → 整个重放事务回滚 → degraded 只读（评价 1/2 实测的 FK 炸库）。
            if (isPurged(str(record.workspaceId), str(record.agentId), num(record.lc) ?? 0)) {
              stats.skipped++
              break
            }
            this.#openVersion(record)
            stats.versions++
            break
          }
          case 'version.close': {
            if (isPurged(str(record.workspaceId), str(record.agentId), num(record.lc) ?? 0)) {
              stats.skipped++
              break
            }
            const versionId = str(record.versionId)
            const validUntil = num(record.validUntil)
            if (!versionId || validUntil === undefined) {
              stats.skipped++
              break
            }
            this.#run(`UPDATE memory_version SET valid_until = ? WHERE version_id = ?`, [
              validUntil,
              versionId,
            ])
            stats.closed++
            break
          }
          case 'version.emotion': {
            // 对称守卫：销毁后残留的情感纠错照常执行只会 UPDATE 一个已删版本（0 行），
            // 无害，但为了和 version.open/close 一致、避免任何「写已销毁 agent」的路径，
            // 统一跳过。
            if (isPurged(str(record.workspaceId), str(record.agentId), num(record.lc) ?? 0)) {
              stats.skipped++
              break
            }
            // 情感纠错（P1-E）：必须跟着漫游，否则 A 机改的情感在 B 机冷启动后被
            // journal 回放吞掉、标签回到旧值。COALESCE 语义与写入端一致：subject/
            // trigger/intensity 为 null 表示"不覆盖，保留原值"，避免回放时误清空。
            const versionId = str(record.versionId)
            if (!versionId) {
              stats.skipped++
              break
            }
            this.#run(
              `UPDATE memory_version
                  SET emo_label = ?, emo_subject = COALESCE(?, emo_subject),
                      emo_trigger = COALESCE(?, emo_trigger),
                      emo_intensity = COALESCE(?, emo_intensity),
                      emo_confidence = ?
                WHERE version_id = ?`,
              [
                str(record.label) ?? null,
                (record.subject ?? null) as string | null,
                (record.trigger ?? null) as string | null,
                (record.intensity ?? null) as number | null,
                num(record.confidence) ?? 1,
                versionId,
              ],
            )
            stats.emotions++
            break
          }
          case 'memory.forget': {
            const entityId = str(record.entityId)
            if (!entityId) {
              stats.skipped++
              break
            }
            this.#run(`UPDATE memory_entity SET status = 'forgotten', updated_at = ? WHERE entity_id = ?`, [
              record.at,
              entityId,
            ])
            stats.forgotten++
            break
          }
          case 'quarantine.add': {
            if (isPurged(str(record.workspaceId), str(record.agentId), num(record.lc) ?? 0)) {
              stats.skipped++
              break
            }
            // 隔离条目必须跟着漫游：换台机器后，"这条被拦过"同样要可见。
            // 之前这里落到 default 只统计数量，结果 B 机隔离区凭空清空 ——
            // 拦截记录消失，比拦截本身失败更难排查。
            const quarantineId = str(record.quarantineId)
            const workspaceId = str(record.workspaceId)
            const agentId = str(record.agentId)
            if (!quarantineId || !workspaceId || !agentId) {
              stats.skipped++
              break
            }
            this.#run(
              `INSERT INTO quarantine (quarantine_id, workspace_id, agent_id, payload, reason, score, status, created_at)
               VALUES (?,?,?,?,?,?,?,?)
               ON CONFLICT(quarantine_id) DO NOTHING`,
              [
                quarantineId,
                workspaceId,
                agentId,
                JSON.stringify({
                  text: str(record.text) ?? '',
                  kind: str(record.kind) ?? 'fact',
                  source: str(record.source) ?? 'external',
                  subjectKey: str(record.subjectKey) ?? null,
                  emotion: record.emotion ?? null,
                }),
                str(record.reason) ?? '',
                num(record.score) ?? 0,
                'pending',
                num(record.at) ?? Date.now(),
              ],
            )
            stats.quarantined++
            break
          }
          case 'skill.bind': {
            if (isPurged(str(record.workspaceId), str(record.agentId), num(record.lc) ?? 0)) {
              stats.skipped++
              break
            }
            // 技能绑定必须跟着漫游：A 挂了 code-exec，B 开机就得有。
            // 只落 SQLite 不重放 = "换机后模型突然不会它本来会的事"，且无报错。
            const agentId = str(record.agentId)
            const workspaceId = str(record.workspaceId)
            const skillId = str(record.skillId)
            if (!agentId || !workspaceId || !skillId) {
              stats.skipped++
              break
            }
            this.#run(
              `INSERT INTO agent_skill (agent_id, workspace_id, skill_id, version, enabled, config, granted_by, updated_at)
               VALUES (?,?,?,?,?,?,?,?)
               ON CONFLICT(agent_id, workspace_id, skill_id) DO UPDATE SET
                 version    = excluded.version,
                 enabled    = excluded.enabled,
                 config     = excluded.config,
                 granted_by = excluded.granted_by,
                 updated_at = MAX(agent_skill.updated_at, excluded.updated_at)`,
              [
                agentId,
                workspaceId,
                skillId,
                str(record.version) ?? '',
                record.enabled === false ? 0 : 1,
                JSON.stringify(record.config ?? {}),
                str(record.grantedBy) ?? 'user',
                num(record.at) ?? Date.now(),
              ],
            )
            stats.skills++
            break
          }
          case 'skill.unbind': {
            if (isPurged(str(record.workspaceId), str(record.agentId), num(record.lc) ?? 0)) {
              stats.skipped++
              break
            }
            const agentId = str(record.agentId)
            const workspaceId = str(record.workspaceId)
            const skillId = str(record.skillId)
            if (!agentId || !workspaceId || !skillId) {
              stats.skipped++
              break
            }
            this.#run(
              `DELETE FROM agent_skill WHERE workspace_id = ? AND agent_id = ? AND skill_id = ?`,
              [workspaceId, agentId, skillId],
            )
            stats.skills++
            break
          }
          case 'persona.bind': {
            // 同名重建信号：agent.purge 之后出现新的 persona.bind，说明用户销毁后又
            // 重建了这个 agentId。撤销墓碑，让后续 entity.upsert / version.* 正常重放
            //（否则等于"销毁过的 agentId 永不复用"，与 KNOWN-ISSUES #1 的承诺相反）。
            const bindWs = str(record.workspaceId)
            const bindAid = str(record.agentId)
            const bindLc = num(record.lc) ?? 0
            // 墓碑可能以 personaId（purge 侧解析后的人格的 id）或 sessionId（persona.bind
            // 的 agent_id）为键——两套 id 空间并存，重建信号必须两个都撤销，否则
            // 「销毁 → 同名重建」在真实宿主里会漏掉墓碑、新记忆仍被跳过。
            for (const key of [bindAid, str(record.personaId)]) {
              if (key && isPurged(bindWs, key, bindLc)) {
                purged.delete(`${bindWs}\u0000${key}`)
              }
            }
            // 会话 → 人格 绑定：这一条掉了，新会话在恢复后的机器上又变成"新人格"，
            // 表现就是"人格与记忆都在，但新建会话读不到"。
            const identityAgent = str(record.agentId)
            const workspaceId = str(record.workspaceId)
            const personaId = str(record.personaId)
            if (!identityAgent || !workspaceId || !personaId) {
              stats.skipped++
              break
            }
            const at = num(record.at) ?? Date.now()
            this.#run(
              `INSERT INTO persona_identity (agent_id, workspace_id, persona_id, bound_at, last_seen_at)
               VALUES (?,?,?,?,?)
               ON CONFLICT(agent_id) DO UPDATE SET
                 workspace_id = excluded.workspace_id,
                 persona_id   = excluded.persona_id,
                 last_seen_at = MAX(persona_identity.last_seen_at, excluded.last_seen_at)`,
              [identityAgent, workspaceId, personaId, at, at],
            )
            stats.personaIdentities++
            break
          }
          case 'persona.update': {
            if (isPurged(str(record.workspaceId), str(record.agentId), num(record.lc) ?? 0)) {
              stats.skipped++
              break
            }
            // 人格内容（名字/年龄/特质/基线哈希）也必须 journal 化：否则两台设备
            // 并发改人格时，state/persona-identity 快照文件 Last-Write-Wins，后快照的
            // 覆盖先快照的，丢失更新。这里按 journal 因果顺序（lc 优先）重放，后写的
            // 覆盖先写的，跨设备合并后两边的编辑都能按序收敛。
            const agentId = str(record.agentId)
            const workspaceId = str(record.workspaceId)
            if (!agentId || !workspaceId) {
              stats.skipped++
              break
            }
            const at = num(record.at) ?? Date.now()
            this.#run(
              `INSERT INTO persona_state (agent_id, workspace_id, name, age, traits, baseline_hash, updated_at)
               VALUES (?,?,?,?,?,?,?)
               ON CONFLICT(agent_id, workspace_id) DO UPDATE SET
                 name = excluded.name, age = excluded.age, traits = excluded.traits,
                 baseline_hash = excluded.baseline_hash, updated_at = excluded.updated_at`,
              [
                agentId,
                workspaceId,
                str(record.name) ?? agentId,
                num(record.age) ?? 10,
                str(record.traits) ?? '{}',
                str(record.baselineHash) ?? '',
                at,
              ],
            )
            stats.personas++
            break
          }
          case 'user_profile.set': {
            // 用户画像必须跟着漫游：换台机器开机，它得记得对面是谁。
            // 这一条如果掉了，表现出来不是报错，而是"模型开始管用户叫另一个人名"。
            const workspaceId = str(record.workspaceId)
            if (!workspaceId) {
              stats.skipped++
              break
            }
            this.#run(
              `INSERT INTO user_profile (workspace_id, display_name, preferred_address, notes, updated_at, updated_by)
               VALUES (?,?,?,?,?,?)
               ON CONFLICT(workspace_id) DO UPDATE SET
                 display_name      = excluded.display_name,
                 preferred_address = excluded.preferred_address,
                 notes             = excluded.notes,
                 updated_at        = MAX(user_profile.updated_at, excluded.updated_at),
                 updated_by        = excluded.updated_by`,
              [
                workspaceId,
                str(record.displayName) ?? '',
                str(record.preferredAddress) ?? '',
                str(record.notes) ?? '',
                num(record.at) ?? Date.now(),
                str(record.updatedBy) ?? 'snapshot',
              ],
            )
            stats.userProfiles++
            break
          }
          case 'agent.purge': {
            // 墓碑：某台机器上"彻底销毁"了一个 Agent。
            // 这条必须让旧快照 replay 时也执行，否则换台机器恢复一次，
            // 被销毁的人就带着记忆复活了——那比不能删更糟。
            const workspaceId = str(record.workspaceId)
            const agentId = str(record.agentId)
            if (workspaceId === undefined || agentId === undefined) {
              stats.skipped++
              break
            }
            // 置位墓碑：之后该 agent 的并发残留写（lc>此值）跳过，直到出现新的
            // persona.bind 撤销。用当前 purge 的 lc（不是"最大 lc"预扫），配合状态机
            // 式 isPurged 判断，支持「销毁 → 同名重建 → 再销毁」的完整生命周期。
            purged.set(`${workspaceId}\u0000${agentId}`, num(record.lc) ?? 0)
            this.#run(
              'DELETE FROM memory_version WHERE entity_id IN (SELECT entity_id FROM memory_entity WHERE workspace_id = ? AND agent_id = ?)',
              [workspaceId, agentId],
            )
            this.#run('DELETE FROM memory_entity WHERE workspace_id = ? AND agent_id = ?', [workspaceId, agentId])
            this.#run('DELETE FROM pitfall WHERE workspace_id = ? AND agent_id = ?', [workspaceId, agentId])
            this.#run('DELETE FROM quarantine WHERE workspace_id = ? AND agent_id = ?', [workspaceId, agentId])
            this.#run('DELETE FROM persona_state WHERE workspace_id = ? AND agent_id = ?', [workspaceId, agentId])
            this.#run('DELETE FROM persona_identity WHERE workspace_id = ? AND agent_id = ?', [workspaceId, agentId])
            // 别的会话若把这个人格当 persona_id 绑定，重放时也要断开：
            // 否则墓碑执行完，绑定还在，下一个会话又顺着它把"这个人"认回来。
            this.#run('DELETE FROM persona_identity WHERE workspace_id = ? AND persona_id = ?', [workspaceId, agentId])
            this.#run('DELETE FROM agent_skill WHERE workspace_id = ? AND agent_id = ?', [workspaceId, agentId])
            // 墓碑重放要连提炼水位一起清：否则重放后"已记过"的水位还在，
            // 复活的会话再也不会被自动提炼。
            this.#run(
              'DELETE FROM distill_cursor WHERE session_id IN (SELECT session_id FROM session_policy WHERE workspace_id = ? AND agent_id = ?)',
              [workspaceId, agentId],
            )
            this.#run('DELETE FROM session_policy WHERE workspace_id = ? AND agent_id = ?', [workspaceId, agentId])
            stats.purged++
            break
          }
          default: {
            // persona.shift / pitfall.promote 由各自模块消费（它们本来就把状态
            // 落在 persona/*.json、pitfalls 表里，恢复阶段单独回灌）。
            // 这里只统计数量，保证"没有悄悄丢掉日志"这件事可观测。
            stats.deferred++
            break
          }
        }
      }
    })
    return stats
  }

  /**
   * 唯一的写入口：把 `undefined` 折成 `null` 再交给 sqlite。
   *
   * node:sqlite 的绑定器认字符串/数字/null/Buffer，唯独不认 `undefined`——
   * 一个可选字段（典型是 emotion 的五个子字段、deviceId）在 journal 里没写，
   * `str()` 返回 undefined，整条 INSERT 就抛 "Provided value cannot be bound to
   * SQLite parameter N"。而这里跑在 `restoreOnBoot` 的重放事务里，抛一次 = 全局
   * degraded = 整个插件只读：用户看到的是"策略写入失败""记忆根本存不进去"，
   * 根因却是某条历史记录少了一个字段。宁可在这一层兜住，也不让启动变只读。
   */
  #run(sql: string, params: readonly unknown[] = []): void {
    this.#db.run(
      sql,
      params.map((value) => (value === undefined ? null : value)),
    )
  }

  #upsertEntity(record: JournalRecord): void {
    const entityId = str(record.entityId)
    if (!entityId) return
    this.#run(
      `INSERT INTO memory_entity (
         entity_id, workspace_id, agent_id, kind, subject_key, canonical,
         salience, trust, status, content_hash, created_at, updated_at, device_id
       ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)
       ON CONFLICT(entity_id) DO UPDATE SET
         canonical = excluded.canonical,
         salience  = excluded.salience,
         trust     = excluded.trust,
         status    = excluded.status,
         updated_at = excluded.updated_at`,
      [
        entityId,
        str(record.workspaceId) ?? '',
        str(record.agentId) ?? '',
        str(record.kind) ?? 'fact',
        str(record.subjectKey) ?? '',
        str(record.canonical) ?? '',
        num(record.salience) ?? 0.5,
        num(record.trust) ?? 0.6,
        str(record.status) ?? 'active',
        // 指纹在写入侧算好；这里用 entityId 兜底，保证 NOT NULL 约束不炸。
        str(record.contentHash) ?? entityId,
        record.at,
        record.at,
        str(record.deviceId) ?? record.device,
      ],
    )
  }

  #openVersion(record: JournalRecord): void {
    const versionId = str(record.versionId)
    const entityId = str(record.entityId)
    if (!versionId || !entityId) return
    const emotion = record.emotion as
      | { subject?: unknown; trigger?: unknown; label?: unknown; intensity?: unknown; confidence?: unknown }
      | null
      | undefined

    // 活跃版本唯一（`uq_version_active ... WHERE valid_until IS NULL`）。
    // 正常写入会先写一条 `version.close`，但 journal 里可能出现"连续两次 open、
    // 中间没有 close"（早期版本的写入侧、或某次崩在半路）。重放时若不先关旧版本，
    // 第二条 INSERT 直接撞唯一索引 → 整个恢复 degraded → 插件变只读。
    // 语义上这样做也是对的：同一实体在时间线上只能有一个"当前版本"。
    const validFrom = num(record.validFrom) ?? record.at
    if (record.validUntil === null || record.validUntil === undefined) {
      this.#run(
        `UPDATE memory_version SET valid_until = ?
         WHERE entity_id = ? AND valid_until IS NULL AND version_id <> ?`,
        [validFrom, entityId, versionId],
      )
    }

    this.#run(
      `INSERT INTO memory_version (
         version_id, entity_id, seq, valid_from, valid_until, text,
         emo_subject, emo_trigger, emo_label, emo_intensity, emo_confidence,
         distill_status, distill_model, supersedes, author, device_id, created_at
       ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
       ON CONFLICT(version_id) DO UPDATE SET
         valid_from  = excluded.valid_from,
         valid_until = excluded.valid_until,
         text        = excluded.text,
         emo_subject = excluded.emo_subject,
         emo_trigger = excluded.emo_trigger,
         emo_label   = excluded.emo_label,
         emo_intensity = excluded.emo_intensity,
         emo_confidence = excluded.emo_confidence`,
      [
        versionId,
        entityId,
        num(record.seq) ?? 0,
        num(record.validFrom) ?? record.at,
        num(record.validUntil) ?? null,
        str(record.text) ?? '',
        str(emotion?.subject),
        str(emotion?.trigger),
        str(emotion?.label),
        num(emotion?.intensity),
        num(emotion?.confidence),
        str(record.distillStatus) ?? 'raw',
        str(record.distillModel),
        str(record.supersedes),
        str(record.author) ?? 'agent',
        str(record.deviceId) ?? record.device,
        record.at,
      ],
    )
  }
}

/**
 * 并发写冲突检测（v0.4 改造 4）。
 *
 * journal 是设备分片 append-only 的 CRDT，不同设备写不同文件天然无「写冲突」；真正的
 * 「冲突」是同一语义目标（同一实体/人格/技能/工作区画像）被两个以上设备在重叠时间窗
 * 内并发改成不同值——重放按 lc 收敛成 LWW，后写的静默覆盖先写的。
 *
 * 这里不阻止并发（无感换机以串行交接为主，加 leader election 代价过高），只把「并发
 * 覆盖」检测出来提示用户，避免静默丢编辑。每设备只取最新一条（同设备连续写是正常追
 * 加，不算并发）。
 */
export interface ConcurrentWrite {
  target: string
  kind: string
  devices: string[]
  windowMs: number
}

export function detectConcurrentWrites(
  records: readonly JournalRecord[],
  windowMs = 60_000,
): ConcurrentWrite[] {
  const targetKey = (record: JournalRecord): string | null => {
    switch (record.op) {
      case 'entity.upsert':
      case 'version.open':
      case 'version.close':
      case 'version.emotion':
      case 'memory.forget': {
        const id = str(record.entityId)
        return id ? `entity:${id}` : null
      }
      case 'persona.update':
      case 'persona.bind': {
        const id = str(record.agentId)
        return id ? `agent:${id}` : null
      }
      case 'skill.bind':
      case 'skill.unbind': {
        const aid = str(record.agentId)
        const sid = str(record.skillId)
        return aid && sid ? `skill:${aid}:${sid}` : null
      }
      case 'user_profile.set': {
        const ws = str(record.workspaceId)
        return ws ? `workspace:${ws}` : null
      }
      default:
        return null
    }
  }

  const byTarget = new Map<string, Map<string, { at: number; device: string }>>()
  for (const record of records) {
    const key = targetKey(record)
    if (!key) continue
    const device = typeof record.device === 'string' ? record.device : 'unknown'
    let perDevice = byTarget.get(key)
    if (!perDevice) {
      perDevice = new Map()
      byTarget.set(key, perDevice)
    }
    const prev = perDevice.get(device)
    if (!prev || record.at > prev.at) perDevice.set(device, { at: record.at, device })
  }

  const conflicts: ConcurrentWrite[] = []
  for (const [target, perDevice] of byTarget) {
    if (perDevice.size < 2) continue
    const entries = [...perDevice.values()].sort((a, b) => a.at - b.at)
    const first = entries[0]
    const last = entries[entries.length - 1]
    if (!first || !last) continue
    const span = last.at - first.at
    if (span <= windowMs) {
      conflicts.push({
        target,
        kind: target.slice(0, target.indexOf(':')),
        devices: entries.map((e) => e.device),
        windowMs: span,
      })
    }
  }
  return conflicts
}

export class RestoreEngine {
  readonly #root: string
  readonly #db: SqlDriver
  readonly #journal: Journal
  readonly #barrier: RestoreBarrier
  readonly #git: GitRunner
  readonly #remote: string
  readonly #branch: string
  readonly #pullStrategy: 'ff-only' | 'rebase'
  readonly #offlinePolicy: 'degraded-readonly' | 'local-only' | 'block'
  readonly #timeoutMs: number
  readonly #retries: number
  readonly #onWarn: (message: string) => void
  readonly #sleep: SleepFn
  readonly #allowMissingSnapshot: boolean

  #lastOutcome: RestoreOutcome | undefined
  /** 上次运行期同步的墙钟时间（并发冲突检测只看这之后的新记录，历史不重复告警）。 */
  #lastSyncAt = 0

  constructor(options: RestoreEngineOptions) {
    this.#root = options.root
    this.#db = options.db
    this.#journal = options.journal
    this.#barrier = options.barrier
    this.#git = options.git
    this.#remote = options.remote ?? ''
    this.#branch = options.branch ?? 'main'
    this.#pullStrategy = options.pullStrategy ?? 'ff-only'
    this.#offlinePolicy = options.offlinePolicy ?? 'degraded-readonly'
    this.#timeoutMs = options.timeoutMs ?? 30_000
    this.#retries = Math.max(0, options.retries ?? 3)
    this.#onWarn = options.onWarn ?? (() => {})
    this.#sleep = options.sleep ?? defaultSleep
    this.#allowMissingSnapshot = options.allowMissingSnapshot ?? true
  }

  get lastOutcome(): RestoreOutcome | undefined {
    return this.#lastOutcome
  }

  /**
   * 启动恢复。**不抛异常**：失败已经被翻译成 degraded 状态，
   * 调用方（index.ts）只需要读 outcome 决定要不要在 UI 上挂黄条。
   */
  async restoreOnBoot(): Promise<RestoreOutcome> {
    try {
      this.#barrier.transition('pulling')
      if (this.#remote.trim()) {
        try {
          await this.#pull()
        } catch (error) {
          // local-only 策略：拉取失败不算故障，继续用本地数据恢复。
          if (!(error instanceof LocalOnlyFallback)) throw error
        }
      } else {
        this.#onWarn('纯本地模式：跳过 git pull，直接用本机数据恢复')
      }

      this.#barrier.transition('verifying')
      const verified = await this.verifyAndReplay()

      this.#barrier.transition('replaying')
      await this.#integrityCheck()

      this.#barrier.markReady()
      const outcome: RestoreOutcome = {
        status: 'ready',
        phase: this.#barrier.phase,
        snapshotId: verified.snapshotId,
        files: verified.files,
        records: verified.records,
      }
      this.#lastOutcome = outcome
      return outcome
    } catch (error) {
      const code = error instanceof RestoreError ? error.code : 'restore-unexpected'
      this.#onWarn(`恢复失败，进入只读降级：${describe(error)}`)
      this.#barrier.fail(code, error)
      const outcome: RestoreOutcome = {
        status: 'degraded',
        phase: this.#barrier.phase,
        code,
        error,
      }
      this.#lastOutcome = outcome
      return outcome
    }
  }

  /**
   * 校验 + 回放（幂等，可反复调用）。
   *
   * 内部会推进 `verifying → replaying`，方便上层单独复用（例如"手动重试恢复"）。
   */
  async verifyAndReplay(): Promise<{ snapshotId?: string; files: number; records: number }> {
    const verified = await this.#verifySnapshotHashes()
    this.#verifySchema()

    // 全量重放：memory.db 不进 git 快照（只同步 journal + state + persona），
    // 本机 memory.db 必须靠 journal 逐条重放重建，不能按水位跳过——
    // 否则跨设备时本机会漏掉"快照之后、本机停机前"其它设备写的事件。
    const records = await this.#journal.readMerged()
    const applier = new ReplayApplier(this.#db)
    const stats = applier.apply(records)

    // 多智能体：记忆由 journal 重放，人格由 persona/*.json + state/agents.json 回灌。
    // 少了这一步，设备 B 开机后"记忆都在，但 Agent 下拉框是空的"。
    const personas = await rehydratePersonaFromRepo({
      db: this.#db,
      root: this.#root,
      onWarn: this.#onWarn,
    })
    if (personas.agents > 0) {
      this.#onWarn(`人格回灌：${personas.agents} 个 Agent / ${personas.personas} 条工作区人格`)
    }

    // 技能回灌：走 state/skills.json（对齐语义），journal 里的 skill.* 事件已在上
    // 面重放过了 —— 两条路径都保留，因为老快照可能没有 skills.json，而新设备
    // 可能只拿到了 journal。present=false 时这里什么都不做。
    const skills = await rehydrateSkillsFromRepo({
      db: this.#db,
      root: this.#root,
      onWarn: this.#onWarn,
    })
    if (skills.present) {
      this.#onWarn(`技能回灌：${skills.agents} 个 Agent / ${skills.bindings} 条绑定`)
    }

    // 用户画像回灌：走 state/user-profile.json。同样是对齐语义——
    // 文件里有的工作区照抄，没有的工作区保持本机现状（老快照不许清空画像）。
    const profiles = await rehydrateUserProfilesFromRepo({
      db: this.#db,
      root: this.#root,
      onWarn: this.#onWarn,
    })
    if (profiles.present) {
      this.#onWarn(`用户画像回灌：${profiles.profiles} 个工作区`)
    }

    // 身份绑定回灌：走 state/persona-identity.json。
    // 顺序放在最后：它不依赖人格数据，但必须晚于人格回灌，这样"新会话继承谁"
    // 拿到的是恢复后的人格 id，而不是本机残留的旧 id。
    const identities = await rehydratePersonaIdentitiesFromRepo({
      db: this.#db,
      root: this.#root,
      onWarn: this.#onWarn,
    })
    if (identities.present) {
      this.#onWarn(`身份绑定回灌：${identities.identities} 个会话`)
    }

    await this.#journal.open()
    return { snapshotId: verified.snapshotId, files: verified.files, records: stats.records }
  }

  /**
   * 运行期后台同步：fetch + pull 远端新数据，然后幂等全量重放进本机 SQLite。
   *
   * 与冷启动 restoreOnBoot 的区别：这里**不**动 barrier（已经 ready），拉取失败也不
   * 降级只读——只是这次没同步上，下个 interval 再试。重放用全量而不是 sinceSeq 增量，
   * 因为墓碑语义（销毁优先）要求每次重放都能看到历史墓碑，否则「销毁前的并发写」会
   * 在增量重放里把已销毁 agent 复活（评价一/三实测的并发墓碑复活）。
   */
  async syncFromRemote(): Promise<{ pulled: boolean; records: number; conflicts: number }> {
    if (!this.#remote.trim()) return { pulled: false, records: 0, conflicts: 0 }
    try {
      await this.#pull()
    } catch (error) {
      // 运行期拉取失败不降级：本地照常工作，等下个 interval 再试。
      if (error instanceof LocalOnlyFallback) return { pulled: false, records: 0, conflicts: 0 }
      this.#onWarn(`运行期同步拉取失败（下个周期重试）：${describe(error)}`)
      return { pulled: false, records: 0, conflicts: 0 }
    }

    // pull 成功后重放。readMerged 的 sinceSeq 是 checkpoint 水位语义，运行期没有
    // checkpoint，且墓碑过滤需要全量历史可见，所以这里用全量重放（幂等，O(n) 但低频）。
    const records = await this.#journal.readMerged()

    // 并发冲突检测（改造 4）：只看本次 sync 之后的新记录，历史并发不重复告警。
    const fresh = this.#lastSyncAt > 0 ? records.filter((r) => r.at >= this.#lastSyncAt) : records
    const conflicts = detectConcurrentWrites(fresh)
    for (const c of conflicts) {
      this.#onWarn(
        `检测到多设备并发写冲突：${c.target} 被 ${c.devices.join('、')} 在 ${c.windowMs}ms 内同时修改，已按时间收敛（后写覆盖先写，请人工核对）`,
      )
    }
    this.#lastSyncAt = Date.now()

    const applier = new ReplayApplier(this.#db)
    const stats = applier.apply(records)

    // 人格/技能/画像/身份也回灌一遍：别的设备可能在这段时间改过它们。
    await rehydratePersonaFromRepo({ db: this.#db, root: this.#root, onWarn: this.#onWarn })
    await rehydrateSkillsFromRepo({ db: this.#db, root: this.#root, onWarn: this.#onWarn })
    await rehydrateUserProfilesFromRepo({ db: this.#db, root: this.#root, onWarn: this.#onWarn })
    await rehydratePersonaIdentitiesFromRepo({ db: this.#db, root: this.#root, onWarn: this.#onWarn })
    // 关键：pull 回远端记录后必须 realignClock 对齐 lc 水位（open() 在已加载时直接
    // return，不会重对齐）。否则本设备接下来写的新事件 lc 低于远端，readMerged 排序时
    // 被排到远端之前 → 跨设备乱序/复活。
    await this.#journal.realignClock()

    return { pulled: true, records: stats.records, conflicts: conflicts.length }
  }

  /** 用户点"重试"：从 degraded 拨回 pulling 再跑一遍。 */
  async retry(): Promise<RestoreOutcome> {
    if (this.#barrier.phase === 'degraded') {
      this.#barrier.transition('pulling')
    } else if (this.#barrier.phase === 'ready') {
      this.#barrier.transition('pulling')
    }
    return this.restoreOnBoot()
  }

  // ── 内部 ────────────────────────────────────────────────────────────────

  /** fetch + pull --ff-only（失败重试，最终抛 `pull-failed` / `pull-conflict`）。 */
  async #pull(): Promise<void> {
    await this.#ensureClone()
    // 必须在任何 checkout 之前钉死行尾：清单里记的是字节的 sha256，
    // 而 Windows 的 core.autocrlf=true 会在 checkout 时把 LF 改成 CRLF，
    // 于是"正常拉取"会被判成 snapshot-corrupt（假篡改）。发布端的引擎做同样的设置。
    await this.#pinLineEndings()

    let lastError = ''
    for (let attempt = 0; attempt <= this.#retries; attempt++) {
      const fetch = await this.#git.run(['fetch', '--prune', 'origin', this.#branch], {
        timeoutMs: this.#timeoutMs,
      })
      if (fetch.code !== 0) {
        const fetchStderr = fetch.stderr.trim()
        // 空远端 = 首次播种：fetch 空裸仓库的 main 分支会报 "couldn't find remote ref main"，
        // 这发生在 fetch 阶段（不是 pull 阶段）。漏识别会按 pull-failed 降级只读，
        // README 模式 B 首次启动就永久死锁（评价四 P0-2 实测复现）。
        if (/couldn't find remote ref|unknown revision|not our ref|empty repository|does not have any commits/i.test(fetchStderr)) {
          this.#onWarn(`远端仓库为空（${fetchStderr}），按首次播种处理：以本地数据为准，稍后 snapshot 推送`)
          return
        }
        lastError = fetchStderr || `fetch exit ${fetch.code}`
        if (attempt < this.#retries) {
          const delay = backoffDelay(attempt)
          this.#onWarn(`git fetch 失败（第 ${attempt + 1} 次）：${lastError}；${delay}ms 后重试`)
          await this.#sleep(delay)
          continue
        }
        throw this.#offline('pull-failed', `git fetch 最终失败：${lastError}`)
      }

      const pullArgs =
        this.#pullStrategy === 'rebase'
          ? ['pull', '--rebase', 'origin', this.#branch]
          : ['pull', '--ff-only', 'origin', this.#branch]
      const pull = await this.#git.run(pullArgs, { timeoutMs: this.#timeoutMs })
      if (pull.code === 0) return

      const stderr = pull.stderr.trim()
      // 空远端 = 首次播种：远端还没有该分支，没有历史可拉。
      // 这不是网络错误（fetch 已成功），也不是冲突——是"第一次把数据推上去之前"的常态。
      // 若按 pull-failed 降级只读，README 模式 B 的首次启动会永久锁死。
      if (/couldn't find remote ref|unknown revision|not our ref|empty repository|does not have any commits/i.test(stderr)) {
        this.#onWarn(`远端仓库为空（${stderr}），按首次播种处理：以本地数据为准，稍后 snapshot 推送`)
        return
      }
      if (/divergent|not possible to fast-forward|CONFLICT/i.test(stderr)) {
        // 快进不了 = 两条时间线分叉，属于冲突而不是网络问题，重试没有意义。
        throw new RestoreError('pull-conflict', `历史分叉，需要人工合并：${stderr}`, stderr)
      }
      lastError = stderr || `pull exit ${pull.code}`
      if (attempt < this.#retries) {
        const delay = backoffDelay(attempt)
        this.#onWarn(`git pull 失败（第 ${attempt + 1} 次）：${lastError}；${delay}ms 后重试`)
        await this.#sleep(delay)
      }
    }
    throw this.#offline('pull-failed', `git pull 最终失败：${lastError}`)
  }

  /**
   * 关掉文本行尾转换。
   *
   * 这是"假篡改"的根源：清单里每一行都是工作区字节的 sha256，而 git 在
   * core.autocrlf=true 的机器上 checkout 时会把 LF 写成 CRLF。字节一变，
   * 一次完全正常的冷启动就会被判成 snapshot-corrupt，然后整台机器降级只读。
   * 宁可让仓库里都存 LF，也不能让校验结果随平台漂移。
   */
  async #pinLineEndings(): Promise<void> {
    for (const [key, value] of [
      ['core.autocrlf', 'false'],
      ['core.eol', 'lf'],
    ] as const) {
      const result = await this.#git.run(['config', key, value])
      if (result.code !== 0) this.#onWarn(`设置 ${key}=${value} 失败：${result.stderr.trim()}`)
    }
  }

  /** 全新设备：仓库目录可能还不存在，先 init + 绑定远端 + 强制同步。 */
  async #ensureClone(): Promise<void> {
    const probe = await this.#git.run(['rev-parse', '--git-dir'])
    if (probe.code !== 0) {
      const init = await this.#git.run(['init', '-b', this.#branch])
      assertGitOk(init, ['init'], 'git-init-failed')
    }
    // repo.path 可能是别的仓库的子目录（父目录的 .git 让 probe 成功），先拒嵌套，
    // 否则 git add -A / fetch 会污染外层项目仓库（评价四 P0-3）。
    await this.#assertNotNested()
    const remotes = await this.#git.run(['remote'])
    const hasOrigin = remotes.stdout
      .split('\n')
      .map((line) => line.trim())
      .includes('origin')
    if (!hasOrigin) {
      const add = await this.#git.run(['remote', 'add', 'origin', this.#remote])
      assertGitOk(add, ['remote', 'add', 'origin'], 'git-remote-add-failed')
    } else {
      // origin 已存在：先验证归属（repo.path 可能指向陌生项目仓库，其 origin 指向
      // 项目远程），一致才允许 set-url 覆盖，防止把记忆拉进/推出别人的仓库。
      await this.#assertRepoOwnership()
      await this.#git.run(['remote', 'set-url', 'origin', this.#remote])
    }
  }

  /**
   * 防御「repo.path 是别的 Git 仓库的子目录」（评价四 P0-3）：`rev-parse --git-dir`
   * 会返回父目录的 .git 让 probe 成功，随后的 fetch/add 会污染外层项目仓库。
   * 尺子：work-tree 顶层必须等于数据根，Windows 大小写不敏感。
   */
  async #assertNotNested(): Promise<void> {
    const toplevel = await this.#git.run(['rev-parse', '--show-toplevel'])
    if (toplevel.code !== 0) return // 无 work tree，交给后续步骤处理。
    const top = resolve(toplevel.stdout.trim()).toLowerCase()
    const root = resolve(this.#root).toLowerCase()
    if (top !== root) {
      throw new RestoreError(
        'repo-hijack',
        `repo.path 嵌套在另一个 Git 仓库内（仓库根「${toplevel.stdout.trim()}」≠ 数据根「${this.#root}」），拒绝拉取`,
        { toplevel: top, root },
      )
    }
  }

  /**
   * 防御「repo.path 指向陌生 git 仓库」。restore 只走同步模式（`#pull` 仅在配置了
   * remote 时调用），所以这里的尺子是：已存在的 origin 必须与配置的 remote 一致。
   * 不一致 = 用户把 repo.path 配到了别人的项目目录，拒绝拉取。
   */
  async #assertRepoOwnership(): Promise<void> {
    const url = await this.#git.run(['remote', 'get-url', 'origin'])
    if (url.code !== 0) return // 无 origin，安全。
    const existing = url.stdout.trim()
    if (existing !== this.#remote) {
      throw new RestoreError(
        'repo-hijack',
        `repo.path 指向的仓库已绑定 remote「${existing}」，与配置「${this.#remote}」不一致，拒绝拉取`,
        { existing, configured: this.#remote },
      )
    }
  }

  /**
   * 逐文件校验 sha256。
   *
   * 没有快照时：如果允许缺失（全新设备第一次开机）就直接过；
   * 否则抛 `snapshot-missing`——"我明明应该有历史，但一份都没有"是危险信号。
   */
  /**
   * 自愈辅助：从 git HEAD（最新快照提交）恢复工作区里的单个文件。
   * 校验失败时先试一次，git 里有干净副本就能救回，避免"截断成 0 字节"这种
   * 可恢复损坏直接降级只读（评价 2 实测新发现）。
   */
  async #selfHealFile(path: string): Promise<boolean> {
    try {
      const checkout = await this.#git.run(['checkout', 'HEAD', '--', path], {
        timeoutMs: this.#timeoutMs,
      })
      return checkout.code === 0
    } catch {
      return false
    }
  }

  async #verifySnapshotHashes(): Promise<{ snapshotId?: string; files: number }> {
    const snapshotId = await this.#latestSnapshotId()
    if (!snapshotId) {
      if (this.#allowMissingSnapshot) {
        this.#onWarn('未发现任何快照清单，按首次启动处理')
        return { files: 0 }
      }
      throw new RestoreError('snapshot-missing', '仓库里没有任何快照清单')
    }

    const manifest = await readManifest(this.#root, snapshotId)
    let checked = 0
    for (const entry of manifest.files) {
      const absolute = join(this.#root, entry.path)
      let bytes: Buffer
      try {
        bytes = await readFile(absolute)
      } catch {
        throw new RestoreError('snapshot-file-missing', `快照文件缺失：${entry.path}`, entry)
      }
      const digest = createHash('sha256').update(bytes).digest('hex')
      if (digest === entry.sha256) {
        checked++
        continue
      }

      // journal 是 append-only 的：快照之后每写一条记忆，文件都会变长，
      // 全文件 sha256 必然对不上。这不是篡改，是"快照之后又说了话"。
      // 所以只校验**快照当时那段前缀**，再逐行验尾巴是不是合法的 journal 记录：
      //   - 前缀变了 → 历史被改写，照样拦；
      //   - 尾巴里混进一行不是 JSON / 没有 v/seq/at/op 的东西 → 有人往里塞垃圾，拦。
      const grew = bytes.length > entry.bytes
      if (grew && allowedToGrow(entry.path)) {
        const prefix = createHash('sha256').update(bytes.subarray(0, entry.bytes)).digest('hex')
        if (prefix === entry.sha256 && validJournalTail(bytes.subarray(entry.bytes))) {
          checked++
          continue
        }
      }

      // 自愈（P0-⑥）：只对「截断成 0 字节」这种可恢复损坏才从 git HEAD 救回——进程被
      // 强杀 / 磁盘写一半会把文件清空，但 git HEAD（最新快照提交）里还有干净副本。非空
      // 但内容对不上 = 真篡改（有人往里塞东西）或坏提交，必须拦下来降级，绝不能静默用
      // git 副本盖掉，否则「篡改检测」形同虚设（评价 2 的篡改测试就是这种：文件非空但
      // 被加了 {"tampered":true}，必须判 snapshot-corrupt 而不是自愈）。
      if (bytes.length === 0) {
        const healed = await this.#selfHealFile(entry.path)
        if (healed) {
          let healedBytes: Buffer
          try {
            healedBytes = await readFile(absolute)
          } catch {
            throw new RestoreError('snapshot-file-missing', `快照文件缺失：${entry.path}`, entry)
          }
          if (createHash('sha256').update(healedBytes).digest('hex') === entry.sha256) {
            this.#onWarn(`自愈：${entry.path} 已被截断成 0 字节，已从 git HEAD 恢复并校验通过`)
            checked++
            continue
          }
        }
      }

      throw new RestoreError(
        'snapshot-corrupt',
        `快照文件校验失败：${entry.path}（期望 ${entry.sha256.slice(0, 12)}… 实际 ${digest.slice(0, 12)}…）`,
        { path: entry.path, expected: entry.sha256, actual: digest },
      )
    }
    return { snapshotId, files: checked }
  }

  async #latestSnapshotId(): Promise<string | undefined> {
    try {
      const entries = await readdir(join(this.#root, 'snapshots'), { withFileTypes: true })
      const ids = entries.filter((entry) => entry.isDirectory()).map((entry) => entry.name).sort()
      return ids.at(-1)
    } catch {
      return undefined
    }
  }

  /** schema 版本闸门：新库自动建表，旧库自动迁移，更高的版本一律拒绝（会丢数据）。 */
  #verifySchema(): void {
    const current = readSchemaVersion(this.#db)
    if (current === SCHEMA_VERSION) return
    if (current > SCHEMA_VERSION) {
      throw new RestoreError(
        'schema-newer',
        `数据库 schema ${current} 比本插件支持的 ${SCHEMA_VERSION} 更新，请先升级插件`,
      )
    }
    const { from, to } = migrate(this.#db, SCHEMA_VERSION)
    this.#onWarn(`schema 迁移：${from} → ${to}`)
  }

  /** 回放后必须过的最后一道闸：库文件结构性损坏直接降级，不要带着坏页继续跑。 */
  async #integrityCheck(): Promise<void> {
    let rows: Array<Record<string, unknown>>
    try {
      rows = this.#db.all<Record<string, unknown>>('PRAGMA integrity_check')
    } catch (error) {
      // JsonDriver 等后端没有 PRAGMA：跳过而不是判死。
      this.#onWarn(`integrity_check 不可用，已跳过：${describe(error)}`)
      return
    }
    const verdict = rows[0] ? Object.values(rows[0])[0] : 'ok'
    if (String(verdict).toLowerCase() !== 'ok') {
      throw new RestoreError('integrity-check-failed', `integrity_check 失败：${String(verdict)}`, rows)
    }
  }

  /** 断网策略：local-only 视为可继续（用本地数据），其余一律按失败处理。 */
  #offline(code: string, message: string): Error {
    if (this.#offlinePolicy === 'local-only') {
      this.#onWarn(`${message}（offlinePolicy=local-only，继续使用本地数据）`)
      return new LocalOnlyFallback(message)
    }
    return new RestoreError(code, message)
  }
}

/** local-only 策略下的"可继续"信号：restoreOnBoot 会把它当作正常通过。 */
class LocalOnlyFallback extends Error {}

/** 只有 append-only 的 journal 允许"快照之后变长"，其余文件必须逐字节一致。 */
function allowedToGrow(path: string): boolean {
  return path.startsWith('journal/')
}

/**
 * 校验 journal 尾巴是不是"正常新写的记录"。
 *
 * 快照之后我们会继续写记忆，文件自然变长；但变长必须长成 journal 的样子：
 * 一行一条 JSON，且带 `v/seq/at/op` 信封。有人往里塞 `{"tampered":true}`
 * 或者把别的文件内容倒进来，这一关会拦下。
 * 唯一放过的是"最后一行没写完整"——进程崩在 write 中间会留下半行。
 */
function validJournalTail(tail: Buffer): boolean {
  if (tail.length === 0) return true
  const text = tail.toString('utf8')
  const lines = text.split('\n')
  for (const [index, line] of lines.entries()) {
    const trimmed = line.trim()
    if (trimmed === '') continue
    const isLast = index === lines.length - 1
    try {
      const record = JSON.parse(trimmed) as Record<string, unknown> | null
      if (record === null || typeof record !== 'object') {
        if (isLast && !text.endsWith('\n')) continue
        return false
      }
      if (typeof record.op !== 'string' || typeof record.at !== 'number') return false
      if (typeof record.v !== 'number' || typeof record.seq !== 'number') return false
    } catch {
      if (isLast && !text.endsWith('\n')) continue
      return false
    }
  }
  return true
}

function describe(error: unknown): string {
  if (error instanceof Error) return `${error.name}: ${error.message}`
  return String(error)
}

function str(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined
}

function num(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

/** 供上层（UI/测试）复用：把毫秒时间转成快照 id。 */
export { snapshotIdOf }
