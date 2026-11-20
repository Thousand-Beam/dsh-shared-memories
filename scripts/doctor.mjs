#!/usr/bin/env node
/**
 * dsh-shared-memories — doctor 自检（scripts/doctor.mjs）
 * ---------------------------------------------------------------------------
 * 一条命令把插件环境的健康检查跑全，用于「插件坏了 / 拉取不下来了」时快速定位。
 * 检查项对应历次真机事故：git 身份缺失（快照静默失败）、快照目录堆积（拖死 agent）、
 * core.autocrlf（sha256 误判）、repo-hijack（记忆推到别人仓库）、时钟偏移（多设备排序错乱）。
 *
 * 用法：
 *   node scripts/doctor.mjs                  # 检查默认数据根 ~/.dsh/shared-memories
 *   node scripts/doctor.mjs --root <path>    # 指定数据根
 *   node scripts/doctor.mjs --keep 5         # 快照保留数（默认 5）
 *   node scripts/doctor.mjs --json           # 输出原始 JSON（给脚本/控制台用）
 *
 * 依赖 lib/ 构建产物（跑的是编译后的 JS）：
 *   npm run build && node scripts/doctor.mjs
 */

import { homedir } from 'node:os'
import { join, resolve } from 'node:path'

/* ── 参数解析 ───────────────────────────────────────────────────────────── */
const argv = process.argv.slice(2)
const flag = (name) => {
  const i = argv.indexOf(`--${name}`)
  return i === -1 ? undefined : argv[i + 1]
}
const root = expandPath(flag('root') ?? '~/.dsh/shared-memories')
const keep = Number(flag('keep') ?? 5)
const remote = flag('remote') ?? ''
const JSON_OUT = argv.includes('--json')

function expandPath(path) {
  const trimmed = path.trim()
  if (!trimmed) return join(homedir(), '.dsh', 'shared-memories')
  if (trimmed === '~') return homedir()
  if (trimmed.startsWith('~/') || trimmed.startsWith('~\\')) return resolve(homedir(), trimmed.slice(2))
  return resolve(trimmed)
}

/* ── 终端配色：走 tty 判断，重定向到文件自动降级 ────────────────────────── */
const TTY = process.stdout.isTTY === true && process.env.NO_COLOR === undefined
const paint = (code) => (text) => (TTY ? `\u001b[${code}m${text}\u001b[0m` : text)
const bold = paint('1')
const dim = paint('2')
const green = paint('32')
const red = paint('31')
const yellow = paint('33')
const cyan = paint('36')

const ICON = { ok: green('✔'), warn: yellow('!'), error: red('✖') }

async function main() {
  // 动态 import 编译产物（和 self-test.mjs 一样，避免再引 TS 运行器）。
  const { runDoctor } = await import('../lib/host/doctor.js')

  const report = await runDoctor({ root, keep, remote })

  if (JSON_OUT) {
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`)
    return
  }

  const env = report.environment
  process.stdout.write(`\n${bold('dsh-shared-memories doctor')}\n`)
  process.stdout.write(`${dim('数据根')}   ${env.dataRoot}\n`)
  process.stdout.write(`${dim('Node')}     ${env.node}\n`)
  process.stdout.write(`${dim('Git')}      ${env.git}\n`)
  process.stdout.write(`${dim('快照目录')} ${env.snapshots}\n`)
  process.stdout.write(`${dim('commit')}   ${env.commits}\n`)
  process.stdout.write(`${dim('journal')}  ${(env.journalBytes / 1024 / 1024).toFixed(1)} MB\n`)

  process.stdout.write('\n')
  for (const f of report.findings) {
    const line = `${ICON[f.severity]} ${f.title}${f.detail ? ` — ${dim(f.detail)}` : ''}`
    process.stdout.write(`${line}\n`)
    if (f.fix) process.stdout.write(`    ${cyan('修复')} ${f.fix}\n`)
  }

  const s = report.summary
  const verdict = report.ok
    ? green(bold(`全部通过（${s.ok} ok / ${s.warn} warn / ${s.error} error）`))
    : red(bold(`发现问题（${s.ok} ok / ${s.warn} warn / ${s.error} error）`))
  process.stdout.write(`\n${verdict}\n`)
  if (!report.ok) process.exitCode = 1
}

main().catch((error) => {
  process.stdout.write(`\n${red(bold('doctor 崩了 ✖'))} ${error instanceof Error ? error.message : String(error)}\n`)
  process.exitCode = 1
})
