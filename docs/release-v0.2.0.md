# 共享记忆 · Shared Memories `v0.2.0`

> **你的 AI 换台机器，还是同一个人。**
> Git 当传输层，JSONL 事件日志当真相源，SQLite 只是物化视图。

这一版把「能跑」变成了「能给人用」：界面重做、技能隔离落地，还修掉了一个会让隔离区在换机后**静默清空**的严重 bug。

---

## 本版聚焦

| 方向 | 一句话 |
|---|---|
| 🎨 **控制台重做** | 丢掉 Tailwind CDN，改用原生 CSS 注入；卡片、胶囊筛选、时间轴竖线，深浅色都成立 |
| 🛡️ **技能隔离与漫游** | Agent 的能力清单跟着快照走，且按 `agent × workspace` 硬隔离 |
| 🐞 **隔离区冷启动修复** | 换机恢复后隔离区不再凭空消失（这条是**数据安全级**修复） |
| 🧪 **一条命令自测** | `npm run self-test`：39 条断言走完写入 → 隔离 → 防投毒 → 技能 → 冷启动 |
| 📦 **发布规范** | README / awesome-dsh-plugin.yml / .gitattributes（`eol=lf` 强制）/ MIT |

---

## 🐞 修复：隔离区在换机后静默清空（请务必升级）

**现象**：A 机拦下的投毒记忆，在 B 机恢复后隔离区是空的。更糟的是，它并没有变回「正常记忆」——它就是**消失了**，仿佛从来没拦过。

**根因**：`quarantine.add` 这条 journal 记录在 `ReplayApplier` 里落进了 `default` 分支，只做了 `stats.deferred++`，没有任何表被写入。

**修法**（两处，缺一不可）：

1. `src/host/memory/poison.ts` —— 写 journal 时补齐 `text / kind / source / subjectKey / emotion`。之前只记了 `quarantineId`，重放时重建出来的是一条空壳。
2. `src/host/snapshot/restore.ts` —— 新增 `case 'quarantine.add'`，按记录重建 payload 并 `INSERT … ON CONFLICT(quarantine_id) DO NOTHING`，同时 `ReplayStats.quarantined++`。

**现在有断言守着**：

```
✔ 隔离区条目也随 journal 漫游到 B 机
✔ 快照被篡改 → 降级而不是静默通过
✔ 错误码是 snapshot-corrupt
✔ 降级后拒绝写入（宁可停摆，不可脏写）
```

---

## 🛡️ 新功能：Skill（技能）的隔离与漫游

Agent A 会跑代码、Agent B 只会搜网页——**能力清单和记忆一样是状态**。

```
snapshot/
├── state/agents.json   version:2 → 指针：skillCount / enabledSkillIds（不含 config）
└── state/skills.json   version:1 → 全量：每个 agent 一条（哪怕空数组）
```

- **三层隔离**：表主键 `(agent_id, workspace_id, skill_id)` → 唯一读取入口 `readSkillBindings(db, scope)`（SQL 固定 `WHERE workspace_id = ? AND agent_id = ?`）→ 注入层不许自查库，只能接收上层传入的清单。
- **双保险恢复**：journal 增量重放 `skill.bind` / `skill.unbind`；`state/skills.json` 做**全量对齐**（清单即真相，多删少补、开关照抄）。
- **老快照不背刺**：文件不存在时回灌返回 `present:false` 并一条都不动，绝不清空本机已有绑定。
- **防注入**：技能 id 要进 System Prompt，所以 `SKILL_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/`，非法 id 在 HTTP 入口就 400。
- **不泄漏清单**：总览页只拿得到 `skillCount`，拿不到别人装了什么。

---

## 🎨 控制台

- **零 CDN**：样式改成运行时注入 `<style>`，令牌全部走宿主 `--dsw-alias-*`，深浅色自动跟随。真机不会再「裸奔」。
- **全面汉化**：`fact → 事实`、`joy → 喜悦`、`anxiety → 焦虑`、`quarantined → 已隔离`……界面上不再漏出任何英文枚举。
- **三段式记忆卡**：顶部状态 + 信任度，中部正文，底部彩色情感标签 + 来源 Agent。
- **胶囊筛选**：类型与情感都是圆角 Pills，选中高亮。
- **快照时间轴**：垂直连线串起节点，节点颜色标出触发方式（手动 / 关机 / 定时 / 空闲 / 回退前保护）。
- **下拉菜单改 React Portal**：之前 `backdrop-filter` 会自建层叠上下文，`z-index` 调多高都压不出去；现在挂到 `body` 上，用按钮实测坐标做 `position: fixed`，滚动/缩放重算，Esc 可关。
- **不再满屏 UUID**：会话没起名就显示「未命名会话」+`#2b81`，完整 id 只进 `title`。
- **没有「心理年龄」这种出戏设定**：卡片上不再贴年龄（内部 `age` 仍保留，作为人格演化的成长刻度）。

---

## 🧪 自测与测试

```bash
npm run build       # tsc ×2 + 单文件 bundle
npm test            # 56 个用例
npm run self-test   # 39 条断言，真 git + 真 SQLite，绿字收尾
npm run preview     # 本地 UI 预览 → http://127.0.0.1:5199/
```

self-test 覆盖：多 Agent 记忆隔离 · 跨工作区检索为 0 · 投毒拦截（`risk=0.807 → quarantine`）· 技能隔离与停用状态漫游 · 换机冷启动 `pull → verify → replay → ready` · 快照篡改后降级只读。

---

## 升级提示

- `SCHEMA_VERSION` 升到 **3**（新增 `agent_skill` 表）。升级是幂等的 `IF NOT EXISTS`，老库直接可用。
- 从 `v0.1.x` 升级后，第一次快照会写 `state/skills.json`；此前的快照里没有这个文件，恢复时按「不记技能」处理，不会动你本机已有的绑定。
- 建议：`git log -p` 过一眼第一份含 `state/skills.json` 的快照提交，确认清单符合预期。

---

## 完整变更日志

### v0.2.0 · 2026-11-16

**新增**
- 技能（Skill）隔离与漫游：`agent_skill` 表、`SkillRegistry`、`state/skills.json`、journal `skill.bind/unbind`、Prompt 技能段（`shared-memories:skills`，order 15）
- `GET /skills` / `POST /skills`（bind / unbind / toggle，恢复期间经 `RestoreBarrier` 拒写）
- 控制台总览页技能计数胶囊
- `npm run self-test`（39 条断言）

**修复**
- 隔离区条目在冷启动恢复后丢失（`quarantine.add` 未重放）
- 下拉菜单被卡片遮挡（改 React Portal + 实测坐标）
- 长 UUID 直出（折叠为 `未命名会话 · #2b81`，完整 id 移入 `title`）

**变更**
- 样式体系从 Tailwind 类改为原生 CSS 注入（`.dsm-*` 命名空间 + 宿主主题令牌）
- 全部界面枚举汉化（`i18n.ts` 统一字典）
- `panel.tsx` / `memory-list.tsx` / `history.tsx` / `rules.tsx` 全量重写
- `package.json` / `awesome-dsh-plugin.yml` 版本对齐 0.2.0

### v0.1.1 · 2026-11-16

- UI 遮挡与可读性修复（下拉层级、UUID 折叠、空状态收敛）
- 新增端到端自测脚本
- 修复隔离区冷启动丢失（与 v0.2.0 同一提交）

### v0.1.0 · 2026-11-16

**首发**
- 全状态快照漫游：`shutdown / interval / idle / manual` 四种触发，sha256 校验，滑窗轮转，pinned 保护
- 冷启动恢复状态机：`cold → pulling → verifying → replaying → ready`，失败转 `degraded` 且只读；`RestoreBarrier` 在 ready 前拒绝一切写入
- 时间树记忆：`openVersion / closeAt / asOf / history`，只切分不覆盖
- 工作区 + Agent 双维隔离写在 SQL 里（`scoped-query.ts:344`），跨 Agent 检索需带 reason/ttl 的 `GlobalToken` 并留审计
- 记忆污染防御：外部内容 `trust=0.25`，底线突破进隔离区，放行即重新 `openVersion`
- 人格与规则四阶升格（现象 → 经验 → 模式 → 规则），`baseline_hash` 上锁
- 19 个 HTTP 端点 + 侧栏控制台（记忆 / 快照 / 规则 / 隔离区 / 总览）
- 零 CDN 运行时注样式、MIT 许可、`eol=lf` 强制、README 与 awesome-dsh-plugin 元数据

---

**完整提交对比**：[`v0.1.0...v0.2.0`](https://github.com/Thousand-Beam/dsh-shared-memories/compare/v0.1.0...v0.2.0)

MIT © 2026 YG
