/**
 * dsh-shared-memories — state 文件多设备读取
 * ---------------------------------------------------------------------------
 * v0.5.x 及更早：state/*.json 是**单文件**，两台设备各写各的全量集合，rebase
 * 时同一文件双改 → add/add 冲突 → 多设备漫游必然分叉（终审 P1-④）。
 *
 * 自 v0.6.0 起：每台设备只写自己的目录 `state/<deviceId>/<name>.json`。
 * 两台设备各自新增/修改的内容落在不同文件里，git rebase 自动合并；
 * 只有「同一台设备的同一个文件」才会冲突——那才是真冲突，该报。
 *
 * 读取端（restore 回灌）扫描所有设备目录，按 deviceId 字典序做确定性的
 * LWW 合并。老快照的单文件格式仍然兼容。
 */

import { readFile, readdir } from 'node:fs/promises'
import { join } from 'node:path'

export interface StateFileCollection {
  /** 磁盘上到底有没有这个文件（任何格式，包括坏文件）。false = 老快照/从未快照，调用方绝不动本机现状。 */
  readonly present: boolean
  /** 按设备目录字典序排列的解析结果（新格式多个，老格式一个）。 */
  readonly parsed: readonly unknown[]
  /** 文件存在但读不出/解析失败的数量（调用方按 failed 上报，不静默吞）。 */
  readonly failures: number
}

/**
 * 读某个 state 文件的所有设备版本。
 *
 * 新格式：`state/<deviceId>/<name>.json`（v0.6.0+）。
 * 老格式：`state/<name>.json`（v0.5.x，与新格式并存时也读——升级过渡期
 * 旧设备还在写老文件，只读新格式会丢它的数据）。
 */
export async function readStateFiles(
  root: string,
  name: string,
  onWarn?: (message: string) => void,
): Promise<StateFileCollection> {
  const warn = onWarn ?? (() => {})
  const parsed: unknown[] = []
  let failures = 0

  // 老格式单文件最先读：时间上它最早（v0.5.x），LWW 里应被新设备版本覆盖。
  try {
    parsed.push(JSON.parse(await readFile(join(root, 'state', name), 'utf8')))
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code
    if (code !== 'ENOENT') {
      // 文件在但坏了：报告失败而不是当作「从未快照」——两者语义不同。
      failures++
      warn(`state/${name} 存在但解析失败：${error instanceof Error ? error.message : String(error)}`)
    }
  }

  let deviceDirs: string[] = []
  try {
    deviceDirs = (await readdir(join(root, 'state'), { withFileTypes: true }))
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .sort()
  } catch {
    deviceDirs = []
  }
  for (const device of deviceDirs) {
    const path = join(root, 'state', device, name)
    try {
      parsed.push(JSON.parse(await readFile(path, 'utf8')))
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code
      // 某个设备没写这个维度（部分设备缺某类状态）是正常的，跳过；
      // 写了但坏了才算 failure。
      if (code !== 'ENOENT') {
        failures++
        warn(`state/${device}/${name} 存在但解析失败：${error instanceof Error ? error.message : String(error)}`)
      }
    }
  }

  return { present: parsed.length > 0 || failures > 0, parsed, failures }
}

/** 把多个文件内容里的同键条目合并成 LWW：后面的覆盖前面的（输入需已按设备目录字典序排好）。 */
export function mergeByKey<T>(
  chunks: readonly unknown[],
  pick: (chunk: Record<string, unknown>) => readonly T[],
  key: (item: T) => string,
): Map<string, T> {
  const out = new Map<string, T>()
  for (const chunk of chunks) {
    const items = isRecord(chunk) ? pick(chunk) : []
    for (const item of items) {
      const k = key(item)
      if (k === '') continue
      out.set(k, item)
    }
  }
  return out
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}
