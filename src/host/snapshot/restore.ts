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
import { join } from 'node:path'
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
  quarantined: number
  skills: number
  userProfiles: number
  personaIdentities: number
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
      quarantined: 0,
      skills: 0,
      userProfiles: 0,
      personaIdentities: 0,
      purged: 0,
      deferred: 0,
      skipped: 0,
    }
    this.#db.transaction(() => {
      for (const record of records) {
        stats.records++
        switch (record.op) {
          case 'entity.upsert': {
            this.#upsertEntity(record)
            stats.entities++
            break
          }
          case 'version.open': {
            this.#openVersion(record)
            stats.versions++
            break
          }
          case 'version.close': {
            const versionId = str(record.versionId)
            const validUntil = num(record.validUntil)
            if (!versionId || validUntil === undefined) {
              stats.skipped++
              break
            }
            this.#db.run(`UPDATE memory_version SET valid_until = ? WHERE version_id = ?`, [
              validUntil,
              versionId,
            ])
            stats.closed++
            break
          }
          case 'memory.forget': {
            const entityId = str(record.entityId)
            if (!entityId) {
              stats.skipped++
              break
            }
            this.#db.run(`UPDATE memory_entity SET status = 'forgotten', updated_at = ? WHERE entity_id = ?`, [
              record.at,
              entityId,
            ])
            stats.forgotten++
            break
          }
          case 'quarantine.add': {
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
            this.#db.run(
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
            // 技能绑定必须跟着漫游：A 挂了 code-exec，B 开机就得有。
            // 只落 SQLite 不重放 = "换机后模型突然不会它本来会的事"，且无报错。
            const agentId = str(record.agentId)
            const workspaceId = str(record.workspaceId)
            const skillId = str(record.skillId)
            if (!agentId || !workspaceId || !skillId) {
              stats.skipped++
              break
            }
            this.#db.run(
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
            const agentId = str(record.agentId)
            const workspaceId = str(record.workspaceId)
            const skillId = str(record.skillId)
            if (!agentId || !workspaceId || !skillId) {
              stats.skipped++
              break
            }
            this.#db.run(
              `DELETE FROM agent_skill WHERE workspace_id = ? AND agent_id = ? AND skill_id = ?`,
              [workspaceId, agentId, skillId],
            )
            stats.skills++
            break
          }
          case 'persona.bind': {
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
            this.#db.run(
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
          case 'user_profile.set': {
            // 用户画像必须跟着漫游：换台机器开机，它得记得对面是谁。
            // 这一条如果掉了，表现出来不是报错，而是"模型开始管用户叫另一个人名"。
            const workspaceId = str(record.workspaceId)
            if (!workspaceId) {
              stats.skipped++
              break
            }
            this.#db.run(
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
            this.#db.run(
              'DELETE FROM memory_version WHERE entity_id IN (SELECT entity_id FROM memory_entity WHERE workspace_id = ? AND agent_id = ?)',
              [workspaceId, agentId],
            )
            this.#db.run('DELETE FROM memory_entity WHERE workspace_id = ? AND agent_id = ?', [workspaceId, agentId])
            this.#db.run('DELETE FROM pitfall WHERE workspace_id = ? AND agent_id = ?', [workspaceId, agentId])
            this.#db.run('DELETE FROM quarantine WHERE workspace_id = ? AND agent_id = ?', [workspaceId, agentId])
            this.#db.run('DELETE FROM persona_state WHERE workspace_id = ? AND agent_id = ?', [workspaceId, agentId])
            this.#db.run('DELETE FROM persona_identity WHERE workspace_id = ? AND agent_id = ?', [workspaceId, agentId])
            this.#db.run('DELETE FROM agent_skill WHERE workspace_id = ? AND agent_id = ?', [workspaceId, agentId])
            // 墓碑重放要连提炼水位一起清：否则重放后"已记过"的水位还在，
            // 复活的会话再也不会被自动提炼。
            this.#db.run(
              'DELETE FROM distill_cursor WHERE session_id IN (SELECT session_id FROM session_policy WHERE workspace_id = ? AND agent_id = ?)',
              [workspaceId, agentId],
            )
            this.#db.run('DELETE FROM session_policy WHERE workspace_id = ? AND agent_id = ?', [workspaceId, agentId])
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

  #upsertEntity(record: JournalRecord): void {
    const entityId = str(record.entityId)
    if (!entityId) return
    this.#db.run(
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
    this.#db.run(
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
        lastError = fetch.stderr.trim() || `fetch exit ${fetch.code}`
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
    const remotes = await this.#git.run(['remote'])
    const hasOrigin = remotes.stdout
      .split('\n')
      .map((line) => line.trim())
      .includes('origin')
    if (!hasOrigin) {
      const add = await this.#git.run(['remote', 'add', 'origin', this.#remote])
      assertGitOk(add, ['remote', 'add', 'origin'], 'git-remote-add-failed')
    } else {
      await this.#git.run(['remote', 'set-url', 'origin', this.#remote])
    }
  }

  /**
   * 逐文件校验 sha256。
   *
   * 没有快照时：如果允许缺失（全新设备第一次开机）就直接过；
   * 否则抛 `snapshot-missing`——"我明明应该有历史，但一份都没有"是危险信号。
   */
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
      if (digest !== entry.sha256) {
        throw new RestoreError(
          'snapshot-corrupt',
          `快照文件校验失败：${entry.path}（期望 ${entry.sha256.slice(0, 12)}… 实际 ${digest.slice(0, 12)}…）`,
          { path: entry.path, expected: entry.sha256, actual: digest },
        )
      }
      checked++
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
