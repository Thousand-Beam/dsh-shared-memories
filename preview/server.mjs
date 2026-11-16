/**
 * dsh-shared-memories — 本地 UI 预览静态服务器（preview/server.mjs）
 * ---------------------------------------------------------------------------
 * 目的：让 `.tsx` 真的在浏览器里画出来，而不是只过一遍类型检查。
 *
 * 为什么自己写一个 60 行的服务器，而不是装 Vite：
 *   1. 这个插件不是应用，它最终以 `.js` 被宿主加载——本地预览只需要"把编译产物
 *      和 HTML 递到浏览器"这一件事，为它引一整套打包器不划算；
 *   2. Vite 会重写模块解析规则，反而掩盖"浏览器能不能按 ESM 加载这些裸导入"这类
 *      真实问题。这里原样伺服 tsc 的产物，看到的就是最逼近宿主的加载行为。
 *
 * 用法：
 *   node preview/server.mjs            # 默认 http://127.0.0.1:5199
 *   node preview/server.mjs 8080       # 换端口
 *   node preview/server.mjs 5199 degraded   # 直接以 degraded 相位开屏（看红色横幅）
 *
 * 注意：本文件不进 npm 包（package.json 的 files 里没有 preview/），也不参与 tsc。
 */

import { createServer } from 'node:http'
import { createReadStream } from 'node:fs'
import { stat } from 'node:fs/promises'
import { extname, join, normalize, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = fileURLToPath(new URL('.', import.meta.url))
const ROOT = resolve(HERE, '..')
const PORT = Number(process.argv[2] ?? 5199)
const PHASE = process.argv[3] ?? ''

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.woff2': 'font/woff2',
}

/** 把一个 URL 路径映射成磁盘路径，并挡住 `../` 越界。 */
function resolvePath(urlPath) {
  const clean = decodeURIComponent(urlPath.split('?')[0] ?? '/')
  const relative = normalize(clean === '/' ? '/preview/index.html' : clean).replace(/^([/\\])+/, '')
  const absolute = resolve(ROOT, relative)
  // 只允许伺服仓库内的文件：`..` 逃逸一律 403。
  if (!absolute.startsWith(ROOT + sep)) return null
  return absolute
}

const server = createServer((req, res) => {
  const target = resolvePath(req.url ?? '/')
  if (!target) {
    res.writeHead(403, { 'content-type': 'text/plain; charset=utf-8' })
    res.end('403 越界访问')
    return
  }

  void stat(target)
    .then((info) => {
      if (!info.isFile()) {
        res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' })
        res.end('404 不是文件')
        return
      }
      res.writeHead(200, {
        'content-type': MIME[extname(target)] ?? 'application/octet-stream',
        'content-length': info.size,
        // 预览要的是"改完刷新就见"，不是缓存命中率。
        'cache-control': 'no-store',
      })
      createReadStream(target).pipe(res)
    })
    .catch(() => {
      const hint =
        target.endsWith('.js')
          ? '\n\n提示：先跑 `npm run preview:build` 生成 preview/out/ 下的编译产物。'
          : ''
      res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' })
      res.end(`404 找不到 ${target}${hint}`)
    })
})

server.listen(PORT, '127.0.0.1', () => {
  const suffix = PHASE ? `?phase=${PHASE}` : ''
  console.log(`\n  共享记忆控制台预览已启动`)
  console.log(`  → http://127.0.0.1:${PORT}/${suffix}\n`)
  console.log(`  静态根目录：${ROOT}`)
  console.log(`  改完源码后：npm run preview:build（或 npx tsc -p preview/tsconfig.preview.json）\n`)
})
