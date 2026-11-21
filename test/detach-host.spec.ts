import test from 'node:test'
import assert from 'node:assert/strict'

import { detachSessionFromWorkspaces } from '../src/index.js'

// 彻底销毁的最后一步：把会话 id 从宿主工作区记账里摘干净。
// 回归背景一二：
//  ① archiveSession 只藏不摘（保留 sessionIds 槽位），宿主重启重扫时被销毁的行又出现
//    ——所以要 detachSession；
//  ② 只 detach 不 unarchive，id 还躺在 archivedSessionIds 里，宿主 UI 会把「已归档
//    但没有归属」的会话兜底渲染成「未分组」组的一行——所以要先把归档标记摘掉。

test('detachSessionFromWorkspaces：先 unarchive 再 detach，跳过无方法的条目', async () => {
  const calls: string[] = []
  const registry = {
    list: () => [
      {
        unarchiveSession: (id: string) => void calls.push(`unarchive:a:${id}`),
        detachSession: async (id: string) => void calls.push(`detach:a:${id}`),
      },
      {
        unarchiveSession: (id: string) => void calls.push(`unarchive:b:${id}`),
        detachSession: async (id: string) => void calls.push(`detach:b:${id}`),
      },
      {}, // 老宿主 / 投影残缺：跳过而不是炸
    ],
  }
  const warns: string[] = []
  const n = await detachSessionFromWorkspaces(registry, 'session-abc', (m) => warns.push(m))
  assert.equal(n, 2)
  assert.deepEqual(calls, [
    'unarchive:a:session-abc',
    'detach:a:session-abc',
    'unarchive:b:session-abc',
    'detach:b:session-abc',
  ])
  assert.deepEqual(warns, [])
})

test('detachSessionFromWorkspaces：服务缺失 / 空 id / 条目抛错都安全', async () => {
  assert.equal(await detachSessionFromWorkspaces(undefined, 'x', () => {}), 0)
  assert.equal(await detachSessionFromWorkspaces({}, 'x', () => {}), 0)
  assert.equal(await detachSessionFromWorkspaces({ list: () => [] }, '', () => {}), 0)

  const warns: string[] = []
  const n = await detachSessionFromWorkspaces(
    {
      list: () => [
        {
          unarchiveSession: async (): Promise<void> => {
            throw new Error('unarchive-boom')
          },
          detachSession: async (): Promise<void> => {
            throw new Error('boom')
          },
        },
      ],
    },
    'session-abc',
    (m) => warns.push(m),
  )
  assert.equal(n, 0)
  assert.equal(warns.length, 2)
  assert.match(warns[0] ?? '', /unarchive-boom/)
  assert.match(warns[1] ?? '', /boom/)
})
