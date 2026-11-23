# 更新日志

## 0.6.4 — 2026-11-23

上架前第三方评审（千问 + GLM-5.3）报告并经复现确认的 8 项缺陷修复。测试基线 199 → 210，self-test 57 条不回归。

### 修复

- **T1（P1）快照回灌覆盖 journal 重放出的新画像 / 新人格。** 回灌的 `updated_at` 改用 `manifest.createdAt`（快照捕获时刻），不再用恢复时刻；`user_profile` 与 `persona_state` 的 upsert 补 `WHERE excluded.updated_at >= <col>`，内容列不再无条件覆盖。此前 v0.6.3 的 V62-07 只修了时间戳写入，回灌内容仍会被旧快照回退——事故现场连 `updated_at` 都被抬到恢复时刻，事后看不出来。
- **T2（P2）`package.json` 带 UTF-8 BOM 导致源码构建失败。** `wrap-client.mjs` 读到 BOM 后 `JSON.parse` 直接抛错，`npm run build` 静默失败、产物缺 `lib/client.js`。去除 BOM，`wrap-client` 增加剥 BOM 防御，CI 增加 `test -f lib/client.js` 断言。
- **T3（P2）防投毒对「身份覆盖」类注入评分不足。** `external` 只判 review（0.425）、`agent` 直接 accept（0.32），与「身份覆盖即高危」的设计宣称不符。命中 `identity-override` 时风险下限抬到 0.6，非 `user` 来源一律进隔离区；用户改自己的名字仍然放行。
- **T4（P2）`Journal.withGate` 把并发调用误判成嵌套。** 原先用一个进程级布尔标志防重入，另一条并发调用链会被当成嵌套直接抛错，互斥排队逻辑形同死代码。改用 `AsyncLocalStorage` 区分「同一条调用链的嵌套」与「另一条并发链」。
- **T5（P2）Consolidator 的 `void journal.append()` 没有 catch。** 磁盘写失败会产生 unhandledRejection，按 Node 默认策略可终止宿主进程。补 catch，失败只走 `onWarn`。
- **T6（P2）`pitfall.record` / `pitfall.promote` 重放没有墓碑守卫。** `purge` 之后，销毁前发出的并发残留写会在重放时把坑重新插回来。两处补墓碑检查，`lc` 晚于墓碑的事件计入 `skipped`。
- **T7（P3）`POST /identity` 的 `personaId` 未校验。** 该值会拼进 `persona/<id>.json` 路径，脏值落库后重启时炸宿主。补 `isSafeScopeToken` 校验，非法值返回 400 `invalid-persona-id`。
- **T8（P3）三处小问题。** README 配置表漏 12 个默认项；`clean-ghost` 清理时 `entityIds` 未按 workspace 过滤，会误删同名 agent 在其它工作区的实体；`personaOverlap` 在词集为空时产生 NaN（当前被 `NaN < 0.05` 恒 false 吞掉，属隐患）。

### 行为变更

- **`GET /persona` 的 `name` 为空时不再回退成 `agentId`**，改为如实返回空串。空名由写侧保证不产生（V62-14），读侧回退是在掩盖上游问题。若有调用方依赖旧的回退行为，需要自行处理空串。

### 验证

- `npm run build` exit 0，产物 `lib/client.js` 211,096 bytes
- `npm run typecheck` 通过
- `npm test` 210/210（新增 11 条，均确认在修复前为红、修复后为绿）
- `npm run self-test` 57/57 不回归

### 已知问题

- 测试 harness 用随机端口起服务，可能命中 undici 的黑名单端口（6000、6665–6669 等）导致偶发 `TypeError: Error: bad port`，重跑即过。属既有问题，非本版引入，计划单独修复（端口被拒时重试一次）。

## 0.6.3 及更早

见 git 标签与提交历史（`git log v0.6.3`）。
