import test from 'node:test'
import assert from 'node:assert/strict'

import { detachSessionFromWorkspaces } from '../src/index.js'

// 彻底销毁的最后一步：把会话 id 从宿主工作区记账里摘掉。
// 回归背景：archiveSession 只藏不摘（保留 sessionIds 槽位），宿主重启重扫时
// 被销毁的行又出现在侧栏——「删不掉的 bug」。detachSession 幂等，交给宿主摘。

test('detachSessionFromWorkspaces：对每个工作区调用 detachSession，跳过无方法条目', async () => {
  const calls: string[] = []
  const registry = {
    list: () => [
      { detachSession: async (id: string) => void calls.push(`a:${id}`) },
      { detachSession: async (id: string) => void calls.push(`b:${id}`) },
      {}, // 没有 detachSession 的条目（老宿主 / 投影残缺）：跳过而不是炸
    ],
  }
  const warns: string[] = []
  const n = await detachSessionFromWorkspaces(registry, 'session-abc', (m) => warns.push(m))
  assert.equal(n, 2)
  assert.deepEqual(calls, ['a:session-abc', 'b:session-abc'])
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
  assert.equal(warns.length, 1)
  assert.match(warns[0] ?? '', /boom/)
})
