/**
 * 架构守卫：把「真机踩过的坑」转成机器可执行的约束。
 *
 * v0.3.4 修过一个幽灵 bug：插件直接删 `~/.dsh/storages/` 下的投影缓存与
 * workspace.json，跟宿主的 workspace registry 内存态打架，侧栏出现「未分组 +
 * 未命名」残骸。这里把「插件不得写宿主的 storages/ 目录」焊死：任何人再把
 * `storages` 路径构造加回代码，CI 立刻红。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFile, readdir } from 'node:fs/promises'
import { join } from 'node:path'

const SRC = join(process.cwd(), 'src')

test('架构守卫：插件代码不得写宿主的 storages/ 目录', async () => {
  const names = await readdir(SRC, { recursive: true })

  const offenders: string[] = []
  for (const name of names) {
    if (!name.endsWith('.ts')) continue
    const text = await readFile(join(SRC, name), 'utf8')
    const lines = text.split('\n')
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i]!
      const trimmed = line.trim()
      // 允许注释里说明「为什么不碰 storages」；代码里出现 storages 路径构造才算犯规。
      if (trimmed.startsWith('//') || trimmed.startsWith('*') || trimmed.startsWith('/*')) continue
      if (line.includes('storages')) {
        offenders.push(`${name}:${i + 1}: ${trimmed}`)
      }
    }
  }

  assert.deepEqual(
    offenders,
    [],
    '插件代码不得写宿主的 storages/ 目录（投影缓存与 workspace.json 是宿主持有状态，' +
      '插件直接改磁盘会跟宿主内存态打架，正是 v0.3.4 修的幽灵 bug）',
  )
})
