/**
 * dsh-shared-memories — 快照清单（manifest）
 * ---------------------------------------------------------------------------
 * 一个快照 = 一堆文件 + 一份清单。清单里每个文件都有 sha256，恢复时逐个校验，
 * 任何一处对不上就拒绝回放（宁可降级，也不要把半个快照灌进时间树）。
 *
 * 目录布局（仓库根）：
 *   journal/devices/<deviceId>/<UTC 日期>.jsonl   真相源（append-only）
 *   persona/<agentId>.json                        人格状态（涌现式）
 *   persona/baseline.md                           底线声明（带锁，改动需强确认）
 *   rules/pinned.md                               由 rule/pattern 升格来的规则
 *   state/agents.json                             多智能体总览（快照时生成）
 *   snapshots/<snapshotId>/manifest.json          本文件
 *   snapshots/pinned.json                         被 Pin 的快照 id 列表
 */

import { createHash } from 'node:crypto'
import { readFile, writeFile, mkdir } from 'node:fs/promises'
import { dirname, join, relative, sep } from 'node:path'

/** 触发原因（PRD 1 / 2 的快照矩阵）。 */
export type SnapshotTrigger = 'interval' | 'idle' | 'shutdown' | 'manual' | 'pre-rollback'

/** 单个文件的清单元数据。 */
export interface SnapshotFileEntry {
  /** 相对仓库根的 POSIX 路径（git 友好，Windows 也统一用 `/`）。 */
  readonly path: string
  readonly sha256: string
  readonly bytes: number
  readonly kind: 'journal' | 'persona' | 'rules' | 'state' | 'meta'
}

/** 快照清单。 */
export interface SnapshotManifest {
  readonly version: 1
  readonly snapshotId: string
  readonly createdAt: number
  readonly device: string
  readonly trigger: SnapshotTrigger
  /** 提交后回填；capture 阶段为空。 */
  readonly commit?: string
  readonly tag?: string
  readonly schemaVersion: number
  /** 快照覆盖到的 agent / workspace（多智能体总览用）。 */
  readonly agentIds: readonly string[]
  readonly workspaceIds: readonly string[]
  /** 各设备 journal 已容纳的最大 seq，恢复后据此做增量。 */
  readonly journalSeq: Readonly<Record<string, number>>
  readonly files: readonly SnapshotFileEntry[]
  readonly totals: { readonly files: number; readonly bytes: number }
  readonly summary: string
}

/** 快照列表项（UI 时间轴用）。 */
export interface SnapshotSummary {
  readonly snapshotId: string
  readonly createdAt: number
  readonly device: string
  readonly trigger: SnapshotTrigger
  readonly summary: string
  readonly files: number
  readonly bytes: number
  readonly pinned: boolean
  readonly commit?: string
}

/** 清单文件相对路径。 */
export function manifestPath(root: string, snapshotId: string): string {
  return join(root, 'snapshots', snapshotId, 'manifest.json')
}

/** Pin 清单路径。 */
export function pinnedIndexPath(root: string): string {
  return join(root, 'snapshots', 'pinned.json')
}

/** 相对仓库根的 POSIX 路径。 */
export function toPosixPath(root: string, absolute: string): string {
  return relative(root, absolute).split(sep).join('/')
}

/** 计算文件 sha256 与字节数；单文件体积上限由 `snapshot.maxBytes` 与排除规则兜住。 */
export async function hashFile(file: string): Promise<{ sha256: string; bytes: number }> {
  const buffer = await readFile(file)
  return { sha256: createHash('sha256').update(buffer).digest('hex'), bytes: buffer.byteLength }
}

export async function writeManifest(root: string, manifest: SnapshotManifest): Promise<string> {
  const file = manifestPath(root, manifest.snapshotId)
  await mkdir(dirname(file), { recursive: true })
  await writeFile(file, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8')
  return file
}

export async function readManifest(root: string, snapshotId: string): Promise<SnapshotManifest> {
  const raw = await readFile(manifestPath(root, snapshotId), 'utf8')
  return JSON.parse(raw) as SnapshotManifest
}

/** 读取 Pin 列表（不存在 = 空）。 */
export async function readPinned(root: string): Promise<Set<string>> {
  try {
    const raw = await readFile(pinnedIndexPath(root), 'utf8')
    const parsed = JSON.parse(raw) as unknown
    if (!Array.isArray(parsed)) return new Set()
    return new Set(parsed.filter((item): item is string => typeof item === 'string'))
  } catch {
    return new Set()
  }
}

export async function writePinned(root: string, pinned: ReadonlySet<string>): Promise<void> {
  const file = pinnedIndexPath(root)
  await mkdir(dirname(file), { recursive: true })
  await writeFile(file, `${JSON.stringify([...pinned].sort(), null, 2)}\n`, 'utf8')
}

/** 由毫秒时间生成快照 id：`20261116T101607Z`（字典序 = 时间序）。 */
export function snapshotIdOf(at: number): string {
  return new Date(at).toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '')
}
