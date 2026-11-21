<div align="center">

# DSH-Shared-Memories

### 基于 Git 的原生外置云脑 · 全状态漫游引擎

**关机即快照，开机即还原。** 换台机器，你的 AI 还是同一个 AI——记忆、人格、技能、会话索引、用户画像，一个字节都不差。

[![License: MIT](https://img.shields.io/badge/License-MIT-3da639.svg?style=flat-square)](LICENSE)
[![Node](https://img.shields.io/badge/node-%E2%89%A522.5-339933.svg?style=flat-square)](https://nodejs.org)
[![DSH](https://img.shields.io/badge/dsh-%E2%89%A50.2.1--rc.3-4c6ef5.svg?style=flat-square)](https://github.com/deepseek-ai)
[![Tests](https://img.shields.io/badge/tests-151%20passing-brightgreen.svg?style=flat-square)](#开发与测试)
[![CI](https://img.shields.io/github/actions/workflow/status/Thousand-Beam/dsh-shared-memories/ci.yml?branch=main&style=flat-square&label=ci)](../../actions)
[![No CDN](https://img.shields.io/badge/frontend-%E9%9B%B6%E5%A4%96%E9%93%BE%E3%80%81%E9%9B%B6%20CDN-8957e5.svg?style=flat-square)](#控制台)

<img src="docs/screenshots/console-memory-dark.png" alt="记忆控制台 · 深色" width="880">

</div>

---

## 这是什么

把「性格 + 记忆 + 工作区会话」当成**可版本化的状态**，用 Git 当传输层。

设备 A 关机 → 打包快照、校验 sha256、提交、打 tag、按滑窗轮转、推远程；
设备 B 开机 → pull、校验、重放、重建人格 → 才允许开口说话。

恢复没走完之前，**任何新对话一律被拒绝**。宁可等三秒，也不要在半成品人格上开始聊天。

```
      ┌────────── 设备 A · 关机 ──────────┐              ┌────────── 设备 B · 开机 ──────────┐
      │ quiesce → capture → sha256        │              │ pull → verify → replay             │
      │ → commit → tag → rotate → push    │ ── git ────▶ │ → rehydrate persona → ready        │
      └───────────────────────────────────┘              └────────────────────────────────────┘
                    │                                                    │
                    └──────────── 同一份 append-only 事件日志 ────────────┘
```

---

## Tell me why

> 记忆插件满地都是，但绝大多数只解决「记住」，不解决「搬家」。下面四条是它存在的理由。

### 1️⃣ 全状态云漫游 —— 换机无感

不是导出/导入一份 JSON。快照池里装的是**整套状态**：人格档案、记忆时间树、规则、工作区会话索引。
新机器 `git pull` 之后跑一遍重放（replay），界面上看到的就是 A 机最后一秒的样子——包括你上周三标过的那条「Windows 换行符会骗过 sha256」。

> 注：单机（模式 A）这套是稳的；**多设备漫游（模式 B）标为实验性**，跨设备时钟偏移有已知风险，见 [KNOWN-ISSUES #1](KNOWN-ISSUES.md)。

### 2️⃣ 多智能体隔离 —— 每个 Agent 独立人格

`workspace_id + agent_id` 的隔离**写在 SQL 编译器里**，不是写在 if 里。
`ScopedQuery` 是唯一入口，每条语句都由 `#scopeClause()` 生成 `AND e.workspace_id = ? AND e.agent_id = ?`，查完还要断言结果集没越界。
跨 Agent 检索默认关闭，开一次要显式令牌 + 审计记录——因为「Python 项目串到 Java 项目」这种事故，用户是看不出来的，只会觉得「这 AI 怎么突然变笨了」。

### 3️⃣ 时间树记忆 —— 只切分，不覆盖

记忆不是一行被 UPDATE 掉的记录，而是一条带 `valid_from / valid_until` 的时间轴。
修正一个错误认知 = 关掉旧版本、开新版本、`seq` 递增、写 journal。历史永远在，`git revert` 也永远有东西可回退。

### 4️⃣ 冷启动强一致性 —— 降级只读，绝不静默

```
cold → pulling → verifying → replaying → ready
                     └──────────────────▶ degraded（只读）
```

`RestoreBarrier.assertWritable()` 是所有写入路径的闸门。恢复未完成时调 `TemporalTree.openVersion()` 会直接抛 `restore-blocked`——**而不是**「先写进去，等会儿再修正」。
脏状态覆盖好状态，是这类系统唯一真正不可逆的事故。

---

## 快速开始

```bash
# 需要 Node >= 22.5（node:sqlite），DSH >= 0.2.1-rc.3
# 包未发布到公共 npm registry，从 GitHub Release 下载 tgz 后本地安装：
# 1. 打开 https://github.com/Thousand-Beam/dsh-shared-memories/releases 下载最新 dsh-shared-memories-*.tgz
# 2. 在 tgz 所在目录执行：
npm i ./dsh-shared-memories-0.5.1.tgz
```

然后在 profile 的 `cordis.patch.yml` 里挂上（插件自带一份可直接用的 `cordis.patch.yml`）：

```yaml
- insert:
    - id: dsh-shared-memories
      name: dsh-shared-memories
```

启动 DSH，左侧栏出现「共享记忆」即安装成功。

### 模式 A · 纯本地（默认，不碰网络）

```yaml
- insert:
    - id: dsh-shared-memories
      name: dsh-shared-memories
      config:
        repo:
          path: ~/.dsh/shared-memories
          remote: ''            # 留空 = 纯本地：快照进本地 Git 仓库，不推送
        sync:
          intervalSec: 300
        snapshot:
          keep: 5
```

能力不打折：时间树、快照池、Pin、回退、隔离区、控制台全都在。只是「换机漫游」这一条用不上——仓库就在本机。

### 模式 B · 云端 Git（多设备漫游，实验性）——手把手

> 同步不是"上传到官方服务器"，而是把快照仓库推到你自己的 **GitHub 私有仓库**，
> 另一台机器冷启动时把它拉回来回灌。GitHub 只当中转盘，记忆本体仍在你自己手里。

> ⚠️ **实验性**：多设备同步依赖各机时钟一致。journal 按 `(时间戳, 设备, 序号)` 排序，
> 跨设备时钟偏移可能让「已删除的记忆」在排序中复活（见 [KNOWN-ISSUES #1](KNOWN-ISSUES.md)）。
> 本地单机（模式 A）无此问题；用模式 B 前请确认各机已开 NTP 时钟同步。

**第 1 步 · 建一个私有仓库（必须私有，记忆是隐私数据）**

网页版：GitHub → `New repository` → 名字随便（如 `ai-brain`）→ **选 Private** → 不要勾 "Add a README"（保持空仓库）→ Create。

命令行版：

```bash
gh repo create ai-brain --private --description "my agent's external brain"
```

**第 2 步 · 配 SSH 免密（默认认证走 ssh-agent，只需配一次）**

```bash
# 已经配过 GitHub SSH 的机器可跳过这步
ssh-keygen -t ed25519 -C "you@example.com" -f ~/.ssh/id_ed25519 -N ""
# 复制公钥，粘贴到 GitHub → Settings → SSH and GPG keys → New SSH key
cat ~/.ssh/id_ed25519.pub
```

Windows 下确保 ssh-agent 开着：`Get-Service ssh-agent` 应是 `Running`，否则 `Start-Service ssh-agent; ssh-add ~/.ssh/id_ed25519`。

**第 3 步 · 填配置，指向那个仓库**

```yaml
- insert:
    - id: dsh-shared-memories
      name: dsh-shared-memories
      config:
        repo:
          path: ~/.dsh/shared-memories
          remote: git@github.com:you/ai-brain.git   # ← 换成你自己的
          branch: main
          authMode: ssh-agent        # ssh-agent | credential-helper | token-ref
          credentialRef: shared-memories/git-token   # 只存钥匙串里的键名，不是令牌本身
        sync:
          enabled: true              # 总开关
          intervalSec: 300           # 每 5 分钟兜底快照
          pushOnCommit: true         # 每次提交立即推送
          pullStrategy: ff-only       # 冷启动拉取策略
        snapshot:
          keep: 5
        restore:
          offlinePolicy: degraded-readonly   # 离线时：只读 / 纯本地 / 阻塞
```

**第 4 步 · 重启 DSH，点控制台顶栏的「测试连接」**

- 显示 `网络 / 凭据 / 分支权限均正常` → 通了，首次启动会自动 init + 首次提交 + 首次推送。
- 显示 `远端没有分支 main（首次推送会创建）` → 也正常，等第一次推送后消失。
- 显示 `git ls-remote exit ...` 或权限错误 → 回第 2 步检查 SSH key 和仓库名。

**第 5 步 · 另一台机器，同样的配置再走一遍**

B 机装好插件、填同样的 `remote` + 配好 SSH，启动时就会自动 `pull` → 校验 sha256 → 重放 journal → 重建人格，然后才允许开口。

**B 机第一次启动会发生什么**：`git pull` → 校验 manifest 里每个文件的 sha256 → 重放 journal → 重建人格 → `ready`。
中间任何一步校验失败，直接进 `degraded`（只读）并把原因写到横幅上，**不会**拿一份坏快照覆盖本地好状态。

**常见问题**

| 现象 | 原因 / 处理 |
|---|---|
| 测试连接报 `Permission denied (publickey)` | SSH key 没加到 GitHub 或 ssh-agent 没加载它 |
| 测试连接报 `repository not found` | 仓库名写错，或私有仓库没权限 |
| 两台机器同时写，会不会覆盖 | 不会——journal 按设备分片，合并成"文件并集"而非二进制冲突 |
| 离线时能用吗 | 能，按 `offlinePolicy` 走：默认只读降级，恢复网络后继续 |

### 三种保存触发

| 触发 | 时机 | 说明 |
|---|---|---|
| `shutdown` | 进程退出前 | 主力通道，`quiesce` 后打包 |
| `interval` | 每 `sync.intervalSec` 秒 | 兜底，防止异常掉电丢一天 |
| `idle` / `manual` | 空闲 / 点击「手动保存」 | 重活之前手动落一版 |

---

## 配置说明

| 键 | 默认 | 说明 |
|---|---|---|
| `repo.path` | `~/.dsh/shared-memories` | 本地 Git 仓库目录（事件日志 + 快照索引都在这） |
| `repo.remote` | `''` | 空 = 纯本地模式，不碰网络 |
| `repo.branch` | `main` | 推送分支 |
| `repo.authMode` | `ssh-agent` | `ssh-agent` / `credential-helper` / `token-ref` |
| `repo.credentialRef` | `shared-memories/git-token` | **只存引用名**，凭据本体在系统钥匙串 |
| `sync.enabled` | `true` | 同步总开关 |
| `sync.intervalSec` | `300` | 定时快照间隔（秒） |
| `sync.pushOnCommit` | `true` | 每次提交后立即推送 |
| `sync.pullStrategy` | `ff-only` | 冷启动拉取策略：`ff-only` / `rebase` |
| `snapshot.keep` | `5` | 滑窗大小；Pin 过的不计入清理 |
| `snapshot.maxBytes` | `268435456`（256MB） | 单次快照体积上限，超了拒绝提交而不是截断 |
| `restore.offlinePolicy` | `degraded-readonly` | `degraded-readonly` / `local-only` / `block` |
| `isolation.strict` | `true` | 关掉它需要改代码，不是改配置 |
| `persona.traitShiftMax` | `0.05` | 单次对话允许的性格漂移上限 |
| `distill.minEmotionConfidence` | `0.6` | 低于这条线的情感标签整条丢弃，不留「大概」 |
| `consolidate.nearDuplicateJaccard` | `0.85` | 近似合并阈值 |
| `consolidate.pruneSalience` | `0.15` | 低于此值且 90 天未召回的条目降级为 `forgotten` |

**没有任何一个默认值是凭据。** `credentialRef` 存的是钥匙串里的键名；明文 token 不会进配置文件，更不会进 Git。

---

## 控制台

原生 CSS，**零 CDN、零外链字体、零运行时下载**——内网机器、离线环境、公司代理后面都能正常渲染。
界面文案全套中文，枚举值一律经过字典（`fact → 事实`、`joy → 喜悦`、`quarantined → 已隔离`），界面上不会出现裸枚举；长 UUID 折叠成 4 位代号，优先展示 Agent 的名字。

| 记忆总览 | 快照时间轴 |
|---|---|
| ![](docs/screenshots/console-memory-light.png) | ![](docs/screenshots/console-snapshots-light.png) |

| 规则与人格 | 隔离区 |
|---|---|
| ![](docs/screenshots/console-rules-light.png) | ![](docs/screenshots/console-quarantine-light.png) |

深浅色跟随宿主主题令牌（`--dsw-alias-*`），Agent 切换器浮层、胶囊筛选、时间轴竖线都在原生 CSS 里手写：

<div align="center">
<img src="docs/screenshots/console-agent-switcher-dark.png" alt="Agent 切换器" width="620">
</div>

---

## 十三项能力

| # | 能力 | 落点 |
|---|---|---|
| 1 | 全状态漫游（Git 快照推拉；多设备为实验性，见 KNOWN-ISSUES #1） | `src/host/snapshot/engine.ts` + `restore.ts` |
| 2 | 快照池滑窗 + Pin + 一键回退 | `engine.ts`（FIFO 跳过 pinned） |
| 3 | 时间树（不覆盖，只切分） | `src/host/memory/timetree.ts` |
| 4 | 归档蒸馏 + 夜间整理 | `distill.ts` + `consolidate.ts` |
| 5 | 工作区强隔离（SQL 编译期） | `memory/scoped-query.ts` |
| 6 | 结构化情感归因 + 置信度闸门 | `timetree.ts` + `distill.ts` |
| 7 | 踩坑四段演进 + 删除（现象→经验→模式→规则） | `memory/pitfall.ts` |
| 8 | 记忆控制台：搜索 / 编辑正文 / 删除 / 情感纠错 | `src/client/memory-list.tsx` + `routes.ts` |
| 9 | 涌现式人格（±0.05 微移）+ 人格档案可编辑 | `prompt/agent-registry.ts` |
| 10 | 记忆污染防御 + 隔离区（洗白 / 销毁） | `memory/poison.ts` |
| 11 | 多端冲突解决（按设备分片） | `shared/journal.ts` |
| 12 | 记忆导入（JSON / Markdown / 自动识别） | `memory/importer.ts` |
| 13 | 一键清除（记忆 + 人格 + 会话日志；**不含 Git 历史**，侧栏行重启后彻底消失） | `memory/purge.ts` |

---

## 三个设计决定，值得单独说

### 一、真相源是事件日志，不是 SQLite

大多数记忆插件的真相源是本地 `memory.db`。它有三个绕不过去的毛病：换设备就没了、多设备同步必然冲突、出事无法回退。

这里把真相源换成 **append-only 的 JSONL 事件日志**，`memory.db` 只是本地物化视图：

| 层 | 内容 | 是否入 Git |
|---|---|---|
| 事件日志 | `journal/devices/<deviceId>/<UTC 日期>.jsonl` | ✅ 文本，可三路合并 |
| 人格与规则 | `persona/<agentId>.json`、`rules/pinned.md` | ✅ |
| 快照索引 | `snapshots/<id>/manifest.json` | ✅ |
| 物化视图 | `memory.db`（`node:sqlite`） | ❌ 随时可从日志重建 |

两台机同时写，合并退化成**文件并集**（因为按设备分片），而不是二进制冲突；任何一次「整理错了」，都能 `git revert` 救回来。

### 二、恢复是状态机，不是一个 await

`RestoreBarrier` 让「恢复中」成为一个**可观测、可拒绝写入**的状态，而不是一段希望它别出错的异步代码。

### 三、蒸馏与整理只碰自己的地盘

- **蒸馏**只在用户主动勾「深度提炼」时发生，LLM 必须返回 JSON；`emotion.confidence < 0.6` 的情感标签整条丢弃，而不是写个大概。
- **整理**只做三件事：精确去重、Jaccard ≥ 0.85 近似合并、`salience < 0.15` 且 90 天未召回的降级。**从不物理删除**——记忆是资产，`status='forgotten'` 还能翻出来。

---

## 技能（Skill）的隔离与漫游

Agent A 会跑代码、Agent B 只会搜网页——**能力清单和记忆一样是状态**，必须跟着人走，且必须隔得住。

### 三层隔离，逐层锁死

| 位置 | 怎么锁 |
|---|---|
| 存储 | `agent_skill(agent_id, workspace_id, skill_id, …)`，主键就是 `(agent, workspace, skill)` |
| 读取 | 只有一个入口 `readSkillBindings(db, scope)`，SQL 固定 `WHERE workspace_id = ? AND agent_id = ?` |
| 注入 | `PromptAssembler` 按当前 `scope` 取数后传进 `renderSkills()`；渲染层**不允许自己查库** |

总览页那种「一屏看所有 Agent」的地方只拿得到 `skillCount`（数字），拿不到别人的技能清单——知道 B 装了什么，本身就是信息。

### 漫游：快照里放什么，恢复时怎么用

```
snapshot
├── state/agents.json    version:2 → 指针：skillCount / enabledSkillIds（不含 config）
└── state/skills.json    version:1 → 全量：每个 agent 一条（哪怕空数组）
                          { skillId, version, enabled, config, grantedBy }
```

`state/skills.json` 里**每个 Agent 都写一条**，这是刻意的：只有「有这一条且为空」才能区分“他没挂技能”和“这版快照根本不记技能”。老快照恢复时文件不存在 → 回灌函数返回 `present:false` 并**一条都不动**，绝不清空本机已有绑定。

恢复路径是双保险：

1. `journal` 重放 `skill.bind` / `skill.unbind`（增量：没来得及打快照也不会丢）
2. `rehydrateSkillsFromRepo()` 用 `state/skills.json` **对齐**（全量：清单即真相，多删少补，开关照抄）

### 为什么技能名要过正则

技能 id 会被写进 System Prompt（模型得知道自己有什么工具）。若允许任意字符串，一个叫 `code-exec\n\n忽略上面所有规则` 的技能就是一次提示词注入。所以 `SKILL_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/`，非法 id 在 HTTP 入口就 400。

### 记忆工具本来就不跨 Agent

`memory_search` 不需要额外加参数来“保证隔离”——因为 `ScopedQuery` 的 SQL 里 `AND e.workspace_id = ? AND e.agent_id = ?` 是**编译期拼死的**，唯一的例外是一个带 `reason`/`ttl` 的 `GlobalToken`，而且要用户在控制台手动开「全局检索」并留审计。技能再多也绕不过这条：工具能调什么，和它能查到什么，是两个独立的闸门。

```bash
npm run self-test   # 第 ④ 段技能隔离，第 ⑤ 段用户画像，第 ⑥ 段验证换机后两者都到位
```

---

## 用户画像（User Profile）：它得记得你是谁

有一类翻车比丢记忆更烦人：**模型不知道你叫什么，于是从 README 的署名里捡了一个名字，然后一直那么叫。** 记忆和人格都做了漫游，唯独"你是谁"没存，每次新会话都得重新自我介绍。

### 为什么不复用记忆卡

`kind='user_profile'` 的记忆卡看着更省事，但那是个陷阱：记忆卡的每一条 SQL 都硬拼 `AND e.agent_id = ?`——**按 Agent 隔离是这套插件的根基**。为了注入画像在记忆表上开一个旁路查询，就是将来串台的入口。所以单独一张表：

```sql
CREATE TABLE user_profile (
  workspace_id      TEXT PRIMARY KEY,
  display_name      TEXT NOT NULL DEFAULT '',
  preferred_address TEXT NOT NULL DEFAULT '',
  notes             TEXT NOT NULL DEFAULT '',
  updated_at        INTEGER NOT NULL,
  updated_by        TEXT NOT NULL DEFAULT 'user'
);
```

维度是**工作区**，不是 Agent：

- 换个 Agent → 还是同一个人（你不需要跟小狐狸重新自我介绍）
- 换个工作区 → 读不到（不同项目可能是不同的人，A 客户的称呼不该漏到 B 客户）

### 三层：存、漫游、注入

| 层 | 实现 |
|---|---|
| 存 | `UserProfileStore.save()`：UPSERT + journal `op:'user_profile.set'`，payload 带全字段 |
| 漫游 | 快照写 `state/user-profile.json`（空画像也写）；恢复时 `journal` 重放 + `rehydrateUserProfilesFromRepo()` 对齐 |
| 注入 | `SECTION_ORDERS.userProfile = 2`，排在底线与人格**之前**——先知道"你是谁"，再谈"我是谁" |

注入文案两条分支，缺一不可：

```
有画像：- 用户叫 张三，希望你称呼为「老张」
        - 就用这个称呼，不要改写成别的人名，也不要给它加额外的演绎或评价
没画像：- 名字尚未记录。
        - 不要猜：不要用仓库作者名、git 提交者、设备名、README 署名或记忆里出现的任何人名来称呼用户。
        - 需要称呼时直接问一句「我该怎么称呼你」。
```

**没画像时的"不要猜"才是止住幻觉的关键**——光靠"没有数据"它照样会编。

### 在控制台里填

全局总览页顶部有「用户画像」卡片，三个字段（名字 / 希望怎么称呼 / 偏好备注），存进当前工作区。备注会被折叠成一行——因为它要拼进提示，允许换行等于允许往提示里插段落。

```bash
npm run self-test   # 第 ⑤ 段：换 Agent 记得你，换工作区读不到，没画像时提示要求"别猜"
```

---

## 会话 id ≠ 人格 id：为什么"新建会话"会失忆

这是 v0.2.2 修掉的最严重的一个 bug，值得单独写一节，因为它的根因在宿主里，不在插件里。

DSH 的 agent 与 session 是同一个东西——宿主 `dsh-agent` 的 `enter()` 里有这么一句：

```js
const id = agent.id
if (id !== agent.session.id) throw new Error('agent id "..." does not match session id "..."')
```

也就是说 **`agent.id === agent.session.id`**。你在界面上点一次「新建会话」，就是一个全新的 agent id。

而人格、记忆、技能、隔离区、规则，全都按 `agent_id` 存。于是：

| 现象 | 真实原因 |
|---|---|
| 新会话自称"小代码酱" | 新 agent id 在 `persona_state` 里没有行，`ensureAgentRow` 建了一行空人格 |
| 记忆总览显示"这个 Agent 还没有任何记忆" | 新 id 在 `memory_entity` 里当然一条都没有 |
| 顶部下拉却还写着「翟千瑶」 | 下拉框读的是另一行 `persona_state`（旧会话那行），列表读的是新 id |

**不能**把记忆表改成按 `workspace_id` 存——那会毁掉多 Agent 隔离（一个工作区里本来就允许并存几个不同的人）。正确做法是加一层指针：

```
会话 id（会变）  ──persona_identity──▶  人格 id（稳定）
   session-8cc2…                         lead / 翟千瑶
```

`persona_identity(agent_id PRIMARY KEY, workspace_id, persona_id, bound_at, last_seen_at)` 就是这张表。读侧只有一个入口 `resolvePersonaId(db, agentId)`：

- `PromptAssembler` 组装提示前先 `resolve`，人格/技能/规则/画像全用解析后的人格 id 取数；
- HTTP 的 `scopeOf()` 同样先解析，所以控制台点「翟千瑶」和模型看到的是同一份数据；
- 写入侧 `agent/created` 走 `PersonaIdentityStore.touch()`：本工作区已有活跃人格时**继承**它，没有才自立门户。

三个必须知道的细节：

1. **继承有窗口**：`identity.inheritOnNewSession`（默认 `true`）+ `identity.inheritWindowMs`（默认 7 天）。关掉开关就是旧的「一会话一人格」行为。
2. **不跨工作区继承**。A 项目的人格绝不会被 B 项目的新会话认领——这和记忆隔离是同一条底线。
3. **绑定也要漫游**。绑定写 journal（`persona.bind`）+ `state/persona-identity.json`，换机器冷启动后回灌。不回灌的话，B 机上点新建会话又是白纸一张。

老库升级不用手动操作：启动时 `backfillPersonaIdentities()` 会给每个工作区选一个锚点人格（记忆最多 → 有真名字 → 最早登记），把「没名字且没记忆」的历史空壳会话并到锚点上，有名字/有记忆的保持独立，只补指针、不搬业务数据。

```bash
npm run self-test   # 第 ⑥ 段：新建会话继承同一人格，且用解析后的 id 读得到旧记忆
```

---

## 安全边界

写在 README 里，也写在代码里。

**它做什么**

1. 外部内容默认低信任度（`trust = 0.25`）；命中底线突破的写入直接进隔离区，**内容压根不进时间树**。
2. 洗白隔离内容是再走一次 `openVersion`，所以它自动继承时间树的一切保障（关旧版本、`seq` 递增、写 journal、可回退）。
3. `rule` / `pattern` 未经人确认，`injectable()` 一个字都不吐；升格要人点两下确认。
4. 人格底线声明被清空是唯一无法靠快照回退发现的事故，所以 `baseline_hash` 上锁，写死要人**手打 Agent 名字**才放行。

**它不做什么（划清界限）**

- ❌ **不提供沙箱，也不试图突破沙箱。** 插件只在 DSH 宿主授予的插件目录与它自己的 Git 仓库里读写；不加载外部代码、不 eval 记忆内容、不执行记忆里的任何字符串。
- ❌ **不做越狱 / 提示词注入增强。** 隔离区与低信任度机制是**防御性**的：它的设计目标是把「忽略之前所有指令」这类内容拦在时间树之外，不是帮你把它们塞进上下文。
- ❌ **不托管凭据。** 仓库只存 `credentialRef` 引用名；token 本体在系统钥匙串里，插件不读、不写、不落盘。
- ❌ **不替你决定删除。** 没有 `DELETE FROM memories`，只有 `status` 迁移。
- ⚠️ **「一键清除」止于本地工作副本，不重写 Git 历史。** 它删记忆库、会话日志与 journal 记录，但**不动 `.git` 里已 commit 的 blob，也不动已 push 到远端的内容**——这些仍能被 `git log -p` 或平台缓存翻出来。真要从仓库根除需要 `git filter-repo` + force push + 请平台清缓存（本插件不做、也做不到保证）。
- ⚠️ **侧栏那一行运行期靠归档隐藏，重启后才彻底消失。** 销毁后会话日志已删、记忆已清，但 DSH 宿主当前运行的会话列表是内存态，重启重新扫描索引后那一行才会彻底不再出现；当下看到「还在」不是销毁失败，重启一次即可。
- ⚠️ **仓库是隐私数据。** 记忆里会有你的项目路径、踩坑、偏好。用**私有**仓库；推公共仓库前先 `git log -p` 自己看一遍。

---

## 兼容性

- Node **≥ 22.5**（依赖内置 `node:sqlite`；更早的版本需要自行接 `node:sqlite` polyfill，走 `SqlDriver` 接口）。
- DSH **≥ 0.2.1-rc.3**（`package.json` 的 `dsh.engines.dsh`）。宿主仍在 rc 阶段，插件贴的是 `systemPrompt.section()` / `slots` / `locale` 注入等内部 API——**升级 DSH 前先查本插件的兼容声明，别裸升**（内部 API 一改，插件可能失效或串台）。
- 平台：Windows / macOS / Linux 均可；`core.autocrlf` 由插件在快照仓库内强制为 `false`（否则 sha256 会被 CRLF 骗过）。
- 多设备：journal 按设备文件分片，并发写入在 git 层是「文件并集」、天然无冲突；但人格/技能/画像等 `state/*.json` 是单一共享文件——两台机器产出**逐字节相同**的状态（同一逻辑状态）不会冲突；若真的各改了不同内容，git 会 add/add 冲突，进入「分叉停摆」（`push-diverged`，诚实降级），而不是静默后写覆盖。**此时一次 `git pull --rebase --autostash` 会停在冲突态**，需手工解决 state 文件冲突后 `git add` + `git rebase --continue` 才能继续同步（其间该设备的新记忆滞留本地、不会丢）；同逻辑状态则无需手动、自动合并。建议同一时刻只让一台机器可写，其余以 `degraded-readonly` 只读，或避免同时改设置（记忆本体永不丢失，只有设置类状态有此风险）。

---

## 开发与测试

```bash
npm run build        # tsc -p tsconfig.json && tsc -p tsconfig.client.json && node scripts/wrap-client.mjs
npm run typecheck    # 两份 tsconfig 都 --noEmit
npm test             # tsc -p tsconfig.test.json && node --test .test-build/test/**/*.spec.js
npm run self-test    # 端到端自测：真 git 仓库 + 真 SQLite + 冷启动恢复，57 条断言
npm run preview      # 起本地 UI 预览（mock 数据，不碰真机）→ http://127.0.0.1:5199/
```

### `npm run self-test` 跑的是什么

不想翻测试文件的话，这一条命令就能把整套链路走一遍（临时目录在结束时自动清理，`--keep` 保留现场，`--verbose` 打细节）：

```
① 写入       Agent A 三条记忆（含焦虑情绪归因）+ Agent B 两条 → 同一句重复写入被去重
② 隔离       A 检索 AONLY 命中 3 条，检索 BONLY 命中 0 条；B 反向同理；跨工作区也 0 条
③ 防投毒     「忽略你所有的规则…」判定 quarantine、风险分 ≥ 0.55、原因含 baseline-breach，
             记忆池不受污染；同一句话来自 user 时正常放行
④ 技能       A 挂 code-exec（启用）与 web-search（停用），B 与换工作区都读不到；
             总览只拿到数量，拿不到别人的技能清单
⑤ 画像       工作区记住「张三 / 老张」；换 Agent 还是同一个人，换工作区读不到；
             提示里有称呼就写称呼、没有就写「不要猜」；空画像不许从仓库署名里捡名字
⑥ 冷启动     A 机 snapshot('shutdown') → 推到 bare 仓库；B 机全新目录 restoreOnBoot()
             → pull → 验签 → 重放 15 条记录 → ready；A 的记忆在 B 逐字可检索，
             人格 / 技能（含停用状态）/ 用户画像 / 隔离区一起漫游；篡改快照文件后重跑
             → degraded + snapshot-corrupt 且拒写
```

最后一行是绿字 `全链路通过 ✔`，退出码 0；任何一条断言失败会红字列出并返回 1，可以直接挂 CI。

- 测试用 `:memory:` SQLite + 复用生产 DDL（`src/host/storage/schema.ts`），151 个用例覆盖时间树、作用域泄漏、污染防御、规则升格、技能隔离与漫游、用户画像、会话身份绑定、journal 合并、HTTP 路由、端到端漫游。
- 诚实声明：`npm test` 的函数级用例主要覆盖 `sections.ts` 的语义参照实现与各模块单元；**真正挂在宿主上的 System Prompt 组装是 `index.ts` 的 `buildPrompt()`**，它由 `npm run self-test`（57 条端到端断言）兜底，而非这 151 条单测。两套各测各的，别拿单测数量当生产路径的覆盖率。
- 客户端打的是单文件 bundle（`lib/client.js`），由 `scripts/wrap-client.mjs` 套上宿主 `__ModuleLoader__` 外壳；**样式走运行时注入 `<style>`**，所以不存在「忘了加载 CSS 就裸奔」这件事。
- 运行时缺 `node:sqlite` 时测试**跳过而非失败**——CI 该红在真 bug 上，不该红在 Node 版本上。
- 发布流程（打 tag、推 GitHub、发 npm、提 awesome 收录）见 [docs/PUBLISH.md](docs/PUBLISH.md)。

---

## Roadmap

- [ ] 快照增量打包（现在每次是全量 tar，仓库长得快）
- [ ] WebDAV / S3 作为 Git 之外的传输层
- [ ] 时间轴可视化（拖动滑块看任意时刻的记忆状态）
- [ ] 记忆冲突的人工合并 UI
- [ ] 可选 embedding 召回（现在召回是 CJK bigram 字面匹配——零依赖、零联网；接入本地 embedding 模型能提升同义改写 / 跨语言召回，代价是 + 依赖 + 体积，且要保持离线）
- [ ] `dsh-shared-memories doctor` 自检命令

---

## 🙏 致谢 (Acknowledgements)

这个项目不是从石头里蹦出来的。它的不少设计决定，来自 DSH 社区里更早出发的那几位的启发——**思路是人家的，实现和取舍是我们自己的**，但该记的账要记清楚。

- **@modusensus/dsh-mneme** —— 借鉴了实体-属性-时间轴模型，以及多路混合召回再重排的检索思路。本项目的「时间树只切分不覆盖」就是站在这个模型上往下推的。
- **dsh-plugin-soul** —— 借鉴了原生 Git 自动 commit 的落盘节奏，以及基于日笔记的人格升格机制；我们把它收敛成了四阶带门禁的升格流程。
- **dsh-brain-memory** —— 借鉴了 FSRS-5 遗忘曲线与性格权重的设计，`salience` 的衰减与召回加权受它影响很深。
- **dsh-mem-weave** —— 借鉴了「记忆与人格深度绑定」和「用户拥有绝对控制权」的理念；本项目的 `baseline_hash` 落锁、隔离区必须人工放行，都是这条理念的直接产物。
- **dsh-mem0** —— 借鉴了夜间批量整理与主题图同步的做法，我们改成了「只做去重/近似合并/降级、永不物理删除」。
- **character-sim** —— 借鉴了 9 轴连续性格模型与「特质微移」的表达方式，人格不再是标签，而是可微调的坐标。
- **dsh-pitfall-memory** —— 借鉴了踩坑记录的四段式收敛（Observation → Lesson → Pattern → Rule），这正是本项目规则升格阶梯的原型。

致敬这些把路先走一遍的人。若有遗漏或归属写错，欢迎开 issue 纠正——**被指出来就改，比装作全是自己原创体面得多**。

---

## License

MIT © 2026 The dsh-shared-memories Authors

<div align="center"><sub>关机即快照，开机即还原。你的 AI 不该因为换台电脑就失忆。</sub></div>
