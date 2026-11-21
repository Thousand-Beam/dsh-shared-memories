# 共享记忆 · Shared Memories `v0.4.3`

> **你的 AI 换台机器，还是同一个人。**
> Git 当传输层，JSONL 事件日志当真相源，SQLite 只是物化视图。

这一版是「无感换机」三条承诺的收口：修掉了两台设备并发时**假 add/add 冲突**（状态文件里混进了每设备可变字段）、`pullStrategy: rebase` 下**每次开机必降级**、以及 `/save` **失败仍返回 200** 三个问题；同时把上一版 `v0.4.2` 修的三个真 P0 一并写进发行说明，作为市场评审的完整记录。

---

## 本版聚焦

| 方向 | 一句话 |
|---|---|
| 🛡️ **状态文件确定性** | 四个共享 JSON 去掉 `device`/`capturedAt`，两台设备同逻辑状态产出**逐字节相同**的文件，并发快照不再假冲突 |
| 🔁 **rebase 路径自愈** | `pull --rebase` 补 `--autostash`，`pullStrategy: rebase` 下不再「首次快照后每次开机 degraded」 |
| ✅ **诚实报错** | 手动快照 push 失败时 `/save` 返回 **409**（而非假 200），前端弹「已本地保存但未推送」 |
| 📦 **发行说明补全** | 把 `v0.4.2` 三个真 P0（push 假失败 / rebase 卡死 / 远端 tag 隐私）逐条写清 |

---

## 🐞 v0.4.2 修复回溯（上一版已修、此版补记录）

### 1. push 假失败 —— `git push` 成功后仍报「推送失败」

`git push` 成功返回后，代码继续执行 `git push --tags`，`--tags` 被远端拒绝时**误判整个 push 失败**。真实场景里本地快照其实已经落地了，但 UI 说没存上。

**修法**：分支 push 与 tag push 拆开，tag 被拒只记告警、不影响分支推送成功判定。

### 2. rebase 永久卡死中间态 —— 分叉后仓库停在 rebase-merge

两台设备同时快照、分支分叉时，引擎跑 `git pull --rebase` 失败后**不执行 `rebase --abort`**，仓库卡在 rebase 中间态，后续每次操作都报「You have unstaged changes」，最终冷启动降级只读。

**修法**：rebase 失败先 `git rebase --abort` 清中间态，再把分叉作为**一等状态**抛 `push-diverged`——宁可诚实停摆、不静默脏写。

### 3. 同秒快照 ID 冲突 —— 两台设备同一秒推同名 tag

快照 id 只精确到秒，两台设备同一秒各自本地目录都空、拿到相同 id，推 `snap/<id>` tag 时被远端拒 `already exists`。

**修法**：快照 id 掺入设备名（`<时间>-<deviceId>`），同秒跨设备天然去重；同设备同秒仍 `-2`/`-3` 递增。

### 4. 远端旧 tag 隐私泄漏 —— rotate 只删本地 tag

滑窗轮转删旧快照时只 `git tag -d` 本地 tag、**从不 `push --delete` 远端 tag**，已销毁的记忆仍能从远端旧 tag 翻出来。

**修法**：rotate 删本地 tag 后同步 `git push origin --delete snap/<id>...`。

### 5. 墓碑守卫不对称 —— 销毁后同名重建 FK 炸库

重放流里 `version.open`/`version.close`/`version.emotion` 三处漏了墓碑守卫，销毁过的 agent 同名重建后冷启动重放会往不存在的实体下插版本 → 外键炸库 → 降级。

**修法**：墓碑从「无条件跳过」改为**状态机**（销毁记 purged、同名 `persona.bind` 撤销 purged），三处补对称守卫。

### 6. 0 字节截断自愈 —— persona 文件被截断后降级粘滞

`persona/*.json` 被截断成 0 字节后冷启动校验失败进 degraded，且跨重启粘滞、不手工 `git checkout` 救不回。

**修法**：校验失败前先尝试 `git checkout HEAD -- <path>` 自愈——**只对 0 字节截断**触发，非空但内容对不上是真篡改、照旧拒。

### 7. doctor 首跑假红 + test-connection 只读探针

- `doctor` 在数据根尚未初始化时报「Git 不可用 / 数据根不可写」假错误（`cwd` 指向不存在的目录）。
- `test-connection` 只做 `ls-remote` 读探针，测不出「能读不能写」。

**修法**：`doctor` 的 git 探测改用用户主目录、未初始化数据根报 warn；`test-connection` 加 `git push --dry-run` 写探针。

---

## 🔧 v0.4.3 变更

### P1-B：状态文件确定性（并发假冲突的真正根因）

上一版把 `capturedAt` 从 `Date.now()` 改成 `this.#clock()`，但 `#clock` 生产注入**就是 `Date.now`**，墙钟毫秒差异根本没消除——两台设备同逻辑状态、只 `capturedAt` 不同，`git rebase` 照样 add/add 冲突。

**本版修法**：四个共享状态文件（`agents.json` / `skills.json` / `user-profile.json` / `persona-identity.json`）**彻底删除 `device` 与 `capturedAt` 字段**。它们本就是每设备可变字段、无任何读者消费，删掉后状态文件 = 纯逻辑状态，两台设备同逻辑状态**逐字节相同**，并发快照不再假冲突。

> 诚实边界：这消除的是「同逻辑状态」的假冲突。两台设备**真的各改了不同内容**，仍会 add/add 冲突 → `push-diverged` 分叉停摆，需要一次手动 `git pull`，不是静默后写覆盖。

### P1-A：`pull --rebase` 补 `--autostash`

`pullStrategy: rebase` 下冷启动拉取，快照故意留脏 manifest，`pull --rebase` 没带 `--autostash` → 每次开机必 degraded。补上 `--autostash` 与引擎 push 侧对齐。

### `/save` 诚实报错

手动快照 push 失败（`push-diverged` / `push-failed`）时，`/save` 从固定 200 改为 **409**，响应体带 `error.code` + `data.pushed=false` + `data.pushReason`；前端弹**黄色告警**「已本地保存但未推送」，不再弹绿「已保存」。

### 文档两处失实

- `sync.pullStrategy` 枚举去掉不存在的 `merge`（schema 只接受 `ff-only` / `rebase`）。
- 多设备段「后写覆盖（Last-Write-Wins）」改如实：同逻辑状态不冲突，真改不同内容会分叉停摆。

---

## 🧪 测试

```bash
npm run build       # tsc ×2 + 单文件 bundle
npm test            # 149 个用例
npm run self-test   # 57 条断言，真 git + 真 SQLite，绿字收尾
```

新增回归：

```
✔ 跨设备同逻辑状态、不同墙钟：状态文件确定性，不触发 diverged（P1-B）
✔ POST /save：pushed=false 时 409 而非 200
```

---

## ⚠️ 实验性 / 已知边界（市场页面如实呈现）

- **多设备是实验性单写交接，不是实时双活**：同一时刻建议只让一台机器可写，其余只读；换机前确认 push 成功。
- 多设备模式需自建私有 Git 仓库 + SSH 凭据 + 各机 NTP 校时。
- 跨设备 purge 墓碑压不过「并发未来写入」的复活边界（销毁与写入真正同时发生时）。
- 冷启动 journal 全量重放 O(n)、快照全量打包导致仓库增长、召回为 CJK bigram 字面匹配——三项均为 roadmap 未竟项。
- 「一键清除」不重写 Git 历史；关机 push 为 fire-and-forget。
- HTTP 面无 CSRF / Origin 校验（归属宿主层，暂缓）。
- 依赖：Node ≥ 22.5（node:sqlite）、DSH ≥ 0.2.1-rc.3（DSH 宿主升级前先核对插件兼容声明）。

---

## 完整变更日志

### v0.4.3 · 2026-11-21

**修复**
- 状态文件确定性：四个共享 JSON 删除 `device`/`capturedAt`，消除并发假 add/add 冲突（P1-B）
- `pull --rebase` 补 `--autostash`，修复 `pullStrategy: rebase` 每次开机 degraded（P1-A）
- `/save` push 失败返回 409 而非 200，前端弹 warn（诚实报错）

**变更**
- README `pullStrategy` 枚举去 `merge`；多设备段去「LWW 后写覆盖」失实表述
- 单测 147 → 149

### v0.4.2 · 2026-11-21

**修复（真 P0 × 3）**
- push 假失败：分支/tag 拆开推，tag 被拒不判分支失败
- rebase 永久卡死：失败先 `rebase --abort`，分叉上抛 `push-diverged`
- 远端旧 tag 隐私泄漏：rotate 同步 `push --delete` 远端 tag

**修复（真 P0 + 附加）**
- 同秒快照 id 掺 deviceId 去重
- 墓碑守卫对称化 + 同名重建合法（状态机）
- persona 0 字节截断自愈（只对截断触发）
- doctor 首跑假红、test-connection 写探针

**变更**：单测 117 → 147

### v0.4.1 · 2026-11-20

- 同秒快照 tag 冲突（CI 修复）——同设备同秒 `-2`/`-3` 递增、`defaultSleep` 去 `unref`
- `pull --rebase --autostash`（engine push 侧）

### v0.4.0 · 2026-11-20

- 无感换机四改造：人格内容 journal 化（`persona.update`）、墓碑语义合并（销毁优先）、运行期后台 pull + 增量重放、并发冲突检测
- 修复三条评审 P0×4（写接口鉴权、空远端死锁、嵌套仓库、假回退）

---

**完整提交对比**：[`v0.4.2...v0.4.3`](https://github.com/Thousand-Beam/dsh-shared-memories/compare/v0.4.2...v0.4.3)

MIT © 2026 The dsh-shared-memories Authors
