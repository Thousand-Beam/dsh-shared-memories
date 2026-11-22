# 发布指南 · dsh-shared-memories

> 目标：仓库从零到 `v0.1.0` tag 推到 GitHub，并准备向 `awesome-dsh-plugin` 提交条目。

---

## 0. 发布前自查

```bash
cd dsh-shared-memories

npm ci                  # 干净装依赖
npm run typecheck       # 两份 tsconfig 都要干净
npm test                # 175/175
npm run build           # 产出 lib/client.js（单文件 bundle）
npm run check:client    # 校验 __ModuleLoader__ 外壳

# 确认没有把凭据、真机数据、构建产物带出去
git status --short
git ls-files | grep -Ei 'memory\.db|node_modules|\.test-build|credential|token'
```

发布清单：

- [x] `package.json` 声明 `dsh.engines.dsh = ">=0.2.1-rc.3"`、`engines.node = ">=22.5.0"`
- [x] `keywords` 含 `dsh-plugin`（GitHub topic 要手动加）
- [x] `LICENSE` = MIT
- [x] `README.md` 有安装、配置、能力、安全边界
- [x] `awesome-dsh-plugin.yml` 条目可用（YAML 已验过）
- [x] 全局无硬编码凭据（凭据只存 `credentialRef` 引用名）
- [x] `.gitignore` 排掉 `node_modules/ lib/ .test-build/ preview/out/ *.db`

---

## 1. 初始化本地仓库

```bash
cd dsh-shared-memories

git init -b main
git config core.autocrlf false          # ⚠️ 关键：CRLF 会让快照 sha256 误判
git add -A
git status --short                      # 再肉眼过一遍暂存内容

git commit -m "feat: initial release v0.1.0 — Git-native external brain for DSH

- full-state roaming: persona + memories + workspace sessions
- snapshot pool with sliding window, pin protection and rollback
- temporal tree memory (valid_from/valid_until), never overwrite history
- workspace isolation enforced in the SQL compiler, audited global search
- quarantine defence against memory poisoning
- web console: native CSS (zero CDN), fully localized zh-CN

175/175 tests passing."
```

若仓库之前已有历史（本次是首次发布可跳过）：

```bash
git log --oneline | head -5
```

---

## 2. 打 tag

```bash
git tag -a v0.1.0 -m "v0.1.0 — 首个可发布版本

Full-state roaming, temporal tree memory, snapshot pool, quarantine defence,
zh-CN web console (native CSS, zero CDN)."

git tag -n1                             # 确认 tag 信息
```

---

## 3. 关联 GitHub 并推送

```bash
# 3.1 建仓库（私有；记忆是隐私数据）
gh repo create dsh-shared-memories --private \
  --description "Git-native external brain and full-state roaming engine for DeepSeek Harness"

# 没有 gh CLI 就用网页建，然后：
# git remote add origin git@github.com:Thousand-Beam/dsh-shared-memories.git

# 3.2 关联（若 gh 已自动加过 origin，跳过这一行）
git remote add origin git@github.com:Thousand-Beam/dsh-shared-memories.git

# 3.3 首推：分支 + tag 一起
git push -u origin main
git push origin v0.1.0

# 3.4 校验
git remote -v
git ls-remote --tags origin
```

---

## 4. GitHub 仓库设置（网页）

1. **About** → Description 填 package.json 的描述；Topics 加：
   `dsh-plugin` `deepseek-harness` `memory` `git` `state-roaming` `multi-agent` `temporal-tree`
2. **Visibility** 保持 **Private**（除非你确认记忆内容可公开）。
3. **Releases** → Draft a new release → 选 tag `v0.1.0` → 标题 `v0.1.0 · 关机即快照，开机即还原`，正文用下面这段：

```markdown
首个可发布版本。

### 能力
- 全状态漫游：人格 + 记忆 + 工作区会话，恢复完成前拒绝新对话
- 快照池滑窗（默认 5）+ Pin 保护 + 一键回退
- 时间树记忆：`valid_from` / `valid_until`，只切分不覆盖
- 工作区隔离在 SQL 编译期强制；跨 Agent 检索需令牌 + 审计
- 记忆污染防御：低信任度准入 + 隔离区
- 中文控制台：原生 CSS，零 CDN，深浅色自适应

### 安装
\`\`\`bash
npm i dsh-shared-memories
\`\`\`

### 兼容
Node >= 22.5 · DSH >= 0.2.1-rc.3
```

---

## 5. （可选）发 npm

```bash
npm run build
npm pack --dry-run        # 看 files 白名单打进去什么，别把 src/ 打进去
npm publish --access public
```

`files` 已限定为 `lib/**/*`、`scripts/wrap-client.mjs`、`cordis.patch.yml`、`README.md`、`LICENSE`。

---

## 6. 提交到 awesome-dsh-plugin

```bash
# fork 目标仓库后
git clone git@github.com:Thousand-Beam/awesome-dsh-plugin.git
cd awesome-dsh-plugin

# 情况 A：条目集中在一个文件里
#   把 awesome-dsh-plugin.yml 里 plugins[0] 那一项追加进 data/plugins.yaml
# 情况 B：一个插件一个文件
cp ../dsh-shared-memories/awesome-dsh-plugin.yml plugins/dsh-shared-memories.yml

git checkout -b feat/add-dsh-shared-memories
git add -A && git commit -m "feat(plugins): add dsh-shared-memories"
git push -u origin feat/add-dsh-shared-memories
gh pr create --title "feat(plugins): add dsh-shared-memories" --body-file ../PR.md
```

PR 正文模板：

```markdown
### 插件
- 名称：dsh-shared-memories
- 仓库：https://github.com/Thousand-Beam/dsh-shared-memories
- 许可：MIT

### 一句话
把人格、记忆与工作区会话打成 Git 快照，换机开机还原到同一状态。

### 为什么不重复
真相源是 append-only JSONL 事件日志（SQLite 只是物化视图），多设备按设备分片、
合并即文件并集；记忆是带 valid_from/valid_until 的时间树；工作区隔离在 SQL
编译期强制，跨 Agent 检索需令牌并留审计。

### 自查
- [x] dsh.engines.dsh 已声明（>=0.2.1-rc.3）
- [x] 客户端 entry 可加载（lib/client.js，__ModuleLoader__ 外壳已校验）
- [x] 无硬编码凭据
- [x] README 含安装 / 配置 / 安全边界
```

---

## 7. 之后每次发布的固定动作

```bash
npm version patch|minor|major   # 同步改 package.json version
npm test && npm run build
git add -A && git commit -m "chore(release): vX.Y.Z"
git tag -a vX.Y.Z -m "vX.Y.Z"
git push && git push origin vX.Y.Z
```

> 版本号规则：UI/文案改动 → `patch`；新增 HTTP 端点或配置项 → `minor`；
> 破坏 `ConsoleBootstrap` / 配置 schema 兼容性 → `major`。
