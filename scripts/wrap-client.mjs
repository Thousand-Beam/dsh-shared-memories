/**
 * dsh-shared-memories — 客户端产物外壳（scripts/wrap-client.mjs）
 * ---------------------------------------------------------------------------
 * 为什么需要这一步：宿主的 Web 端不用原生 ESM 加载插件，而是把 `lib/client.js`
 * 塞进 `window.__ModuleLoader__.load({ id, factory })` 交给它自己的模块加载器。
 *
 *   window.__ModuleLoader__.load({
 *     id: 'dsh-shared-memories',
 *     factory: (require) => { ... return module.exports },
 *   })
 *
 * factory 收到的是一个宿主注入的 `require`：`react`、`react-dom` 这些由宿主提供
 * 单实例（这一点很关键——两份 React 会让 hooks 直接报 "Invalid hook call"），
 * 插件自己的模块则必须在这一个文件里自洽。所以这里做两件事：
 *
 *   1. 用 esbuild 把 `lib/client/index.js` 及其相对导入打成一个 CJS 包；
 *   2. 把它塞进 factory，写成 `lib/client.js`（这个路径与 package.json 的
 *      exports['./client'] 必须逐字一致）。
 *
 * 不做的事：不压缩、不混淆、不 tree-shake 掉注释。插件的客户端代码体量很小，
 * 保留可读性比省那几 KB 值钱——出问题时用户能直接在浏览器里读懂栈帧。
 *
 * 用法：
 *   node scripts/wrap-client.mjs            # 构建（先跑 tsc）
 *   node scripts/wrap-client.mjs --check    # 只校验已有产物外壳是否完整
 */

import { readFile, writeFile, stat } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import * as esbuild from 'esbuild'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = resolve(HERE, '..')
const ENTRY = resolve(ROOT, 'lib/client/index.js')
const OUT = resolve(ROOT, 'lib/client.js')

/** 宿主提供的单实例模块：必须 external，绝不能被打进包里。 */
const EXTERNAL = [
  'react',
  'react-dom',
  'react/jsx-runtime',
  'react-dom/jsx-runtime',
  'react-dom/client',
  'react-dom/server',
  '@deepseek-ai/*',
]

const check = process.argv.includes('--check')

main().catch((error) => {
  console.error(`\n✖ 客户端外壳构建失败：${error instanceof Error ? error.message : String(error)}\n`)
  process.exit(1)
})

async function main() {
  const pkg = JSON.parse(await readFile(resolve(ROOT, 'package.json'), 'utf8'))
  const id = String(pkg.name)

  if (check) {
    const existing = await readFile(OUT, 'utf8')
    const wrapped = hasWrapper(existing, id)
    console.log(wrapped ? `✔ ${OUT} 外壳完整（id=${id}）` : `✖ ${OUT} 缺 __ModuleLoader__ 外壳`)
    if (!wrapped) process.exit(1)
    return
  }

  await ensureEntry()
  const source = await readFile(ENTRY, 'utf8')
  assertExports(source)

  const built = await esbuild.build({
    entryPoints: [ENTRY],
    bundle: true,
    // CJS 是宿主 factory 的方言：它给我们 `require`，我们交出 `module.exports`。
    format: 'cjs',
    platform: 'browser',
    target: ['es2022'],
    // 保留可读性：这不是要发 CDN 的库，是要在用户浏览器里被读懂的单文件。
    minify: false,
    sourcemap: false,
    legalComments: 'inline',
    external: EXTERNAL,
    write: false,
    logLevel: 'silent',
  })

  const code = built.outputFiles?.[0]?.text ?? ''
  if (code.length === 0) throw new Error('esbuild 没有产出内容')

  assertNoNodeBuiltins(code)
  assertRewrittenImportsRemain(code)
  // 宿主的客户端加载器是"传统脚本 + 注入 require"，不是 ESM：
  // 顶层只要残留一条 import/export，整个 entry 会 import failed（页面直接起不来）。
  assertCommonJsOnly(code)

  const file = wrap(code, id)
  await writeFile(OUT, file, 'utf8')
  // 入口校验放在写产物之后：`dsh.client.entry` 指向的正是 OUT，必须先写出来再验，
  // 否则 clean build（删 lib 后重建）会在这里自己绊倒自己。
  await assertPackageEntryPoints(pkg)

  console.log(`✔ ${OUT}`)
  console.log(`  入口    ${ENTRY}`)
  console.log(`  大小    ${Buffer.byteLength(file, 'utf8').toLocaleString('en-US')} bytes`)
  console.log(`  外壳    window.__ModuleLoader__.load({ id: "${id}", factory })`)
  console.log(`  external ${EXTERNAL.join(', ')}`)
}

/** 入口不存在时，给出"你忘了先编译"这种能直接照做的提示。 */
async function ensureEntry() {
  try {
    const info = await stat(ENTRY)
    if (!info.isFile()) throw new Error('not a file')
  } catch {
    throw new Error(`找不到 ${ENTRY} —— 先跑 \`tsc -p tsconfig.client.json\`（或 \`npm run build\`）`)
  }
}

/**
 * 入口必须导出的三样东西：`name`、`inject`、`apply`。
 * 少了 apply，宿主会把这个文件当成一个"什么都没做"的插件静默跳过——比报错更难查。
 */
function assertExports(source) {
  const missing = ['name', 'inject', 'apply'].filter(
    (key) => !new RegExp(`export\\s+(const|function|let|var|class)\\s+${key}\\b`).test(source) &&
      !new RegExp(`export\\s*\\{[^}]*\\b${key}\\b`).test(source),
  )
  if (missing.length > 0) {
    throw new Error(`客户端入口缺少导出：${missing.join(', ')}（宿主需要 name / inject / apply）`)
  }
}

/** 浏览器里没有 node:fs 这类东西；一旦混进构建图，真机上只会看到一句莫名的 import 失败。 */
function assertNoNodeBuiltins(code) {
  const hits = [...code.matchAll(/require\(["'](node:[a-z/_-]+)["']\)/g)].map((m) => m[1])
  if (hits.length > 0) {
    throw new Error(`客户端产物里出现了 Node 内置模块：${[...new Set(hits)].join(', ')}`)
  }
}

/** 相对导入必须已经被 esbuild 打平；残留说明 external 配置误伤了自己的文件。 */
function assertRewrittenImportsRemain(code) {
  const relative = [...code.matchAll(/require\(["'](\.[^"']*)["']\)/g)].map((m) => m[1])
  if (relative.length > 0) {
    throw new Error(`客户端产物里残留相对导入（应已被打包）：${[...new Set(relative)].join(', ')}`)
  }
}

/**
 * 产物必须是**纯 CJS**：不许有顶层 `import` / `export` 语句。
 *
 * 宿主用 `factory(require) { ... return module.exports }` 的传统脚本方式执行它，
 * 见到 ESM 语法不会帮你降级——整条 entry 直接加载失败，桌面端表现为
 * "web boot: 1 entry did not activate"。这个断言把事故挡在构建阶段。
 */
function assertCommonJsOnly(code) {
  const offenders = []
  for (const [index, raw] of code.split('\n').entries()) {
    const line = raw.trim()
    // 字符串/模板里的 "export " 不会出现在行首，这里只认语句位置。
    if (/^(import\s+[^\s(]|import\s*\{|import\s*\*)/.test(line)) offenders.push(`${index + 1}: ${line.slice(0, 80)}`)
    if (/^export\s+(default\b|const\b|function\b|class\b|let\b|var\b|\{|\*)/.test(line)) offenders.push(`${index + 1}: ${line.slice(0, 80)}`)
  }
  if (offenders.length > 0) {
    throw new Error(`客户端产物必须是 CJS，但发现 ESM 语句：\n${offenders.slice(0, 8).join('\n')}`)
  }
  if (!code.includes('module.exports')) {
    throw new Error('客户端产物没有写出 module.exports —— factory 会返回空壳，宿主判定 entry 未激活')
  }
}

/**
 * 校验 package.json 的入口都指向**真实存在**的文件：
 *   - `main` / `exports['./client'].default`：宿主解析包的入口；
 *   - `dsh.client.entry`：Web 端加载客户端的路径；
 *   - `dsh.bundle.patch`：宿主安装插件时要读的 patch 文件。
 * 任何一条指错，用户侧看到的就是"插件装了但没反应"或启动失败。
 */
async function assertPackageEntryPoints(pkg) {
  const wanted = []
  if (typeof pkg.main === 'string') wanted.push(['main', pkg.main])
  const clientExport = pkg.exports?.['./client']?.default
  if (typeof clientExport === 'string') wanted.push(["exports['./client'].default", clientExport])
  if (typeof pkg.dsh?.client?.entry === 'string') wanted.push(['dsh.client.entry', pkg.dsh.client.entry])
  if (typeof pkg.dsh?.bundle?.patch === 'string') wanted.push(['dsh.bundle.patch', pkg.dsh.bundle.patch])

  const missing = []
  for (const [label, relative] of wanted) {
    try {
      const info = await stat(resolve(ROOT, relative))
      if (!info.isFile()) missing.push(`${label} → ${relative}（不是文件）`)
    } catch {
      missing.push(`${label} → ${relative}（不存在）`)
    }
  }
  if (missing.length > 0) throw new Error(`package.json 入口配置指向了不存在的文件：\n${missing.join('\n')}`)

  // 客户端入口必须和 OUT 是同一个文件，否则我们写的产物根本没人加载。
  if (typeof pkg.dsh?.client?.entry === 'string' && resolve(ROOT, pkg.dsh.client.entry) !== OUT) {
    throw new Error(`dsh.client.entry (${pkg.dsh.client.entry}) 必须等于构建产物 ${OUT}`)
  }
}

function hasWrapper(text, id) {
  return (
    text.includes('window.__ModuleLoader__.load(') &&
    text.includes(`id: "${id}"`) &&
    text.includes('factory:')
  )
}

/**
 * 套上宿主外壳。
 * `module` / `exports` 两个 var 是 CJS 运行时契约：esbuild 的产物会直接写
 * `module.exports = __toCommonJS(...)`，所以这里必须用同名的局部变量。
 */
function wrap(code, id) {
  return `/* eslint-disable */
/* 由 scripts/wrap-client.mjs 生成，请勿手改；改 src/client/ 后重新 npm run build。 */
window.__ModuleLoader__.load({
  id: ${JSON.stringify(id)},
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;

${indent(code, 4)}
    return module.exports;
  },
});
`
}

function indent(text, spaces) {
  const pad = ' '.repeat(spaces)
  return text
    .split('\n')
    .map((line) => (line.length === 0 ? line : pad + line))
    .join('\n')
}
