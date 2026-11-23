# v0.6.4

上架前第三方评审（千问 + GLM-5.3 两份独立报告）合并去重后提出的 8 项缺陷，全部修复。

两份报告几乎没有交集：千问只看到构建与防投毒，GLM 只看到回灌与并发。合并后按「用户能不能自己发现」重排了优先级——**静默回退比构建失败更重**。

## 快照回灌不再覆盖 journal 重放出的新画像

v0.6.3 声称修过这个问题（V62-07），实际没生效。

回灌时读的 `capturedAt` 是 `server` 侧刻意不写的字段——`engine.ts` 为了保证状态文件「逐字节确定」，从来不写 `capturedAt` 和 `device`（墙钟每设备不同会造成假 add/add 冲突）。于是回灌侧读到的永远是 `undefined`，兜底成恢复时刻，`MAX` 比较恒判「回灌更新」，旧快照静默压掉新画像；连 `updated_at` 都被改写成恢复时刻，事后从时间戳上看不出发生过回退。

现在 `capturedAt` 的真相改从 `manifest.createdAt`（快照捕获时刻）取，由 `restore.ts` 显式传进回灌流程。

更要紧的是另一半：`user_profile` 的 UPSERT 里，`display_name` / `preferred_address` / `notes` 三个内容列是无条件 `= excluded.*`，`MAX` 只写在了 `updated_at` 上。也就是说光把 `capturedAt` 传对，修好的只是「掩盖痕迹」，不是「停止回退」。两处一并补：`WHERE excluded.updated_at >= user_profile.updated_at`，人格链路同款。

## 构建不再被 package.json 的 BOM 卡死

`package.json` 首字节是 `EF BB BF`，`readFile(...,'utf8')` 不剥 BOM，`JSON.parse` 直接抛 `Unexpected token '﻿'`，`wrap-client` 失败，`npm run build` 整个断在最后一步，产物缺 `lib/client.js`。

BOM 已去除（这是 v0.3.8 之后混进来的），`wrap-client.mjs` 增加剥 BOM 防御，CI 补一条 `test -f lib/client.js` 断言——构建「成功但缺产物」这种错误，只跑 exit code 是发现不了的。

## 身份覆盖类注入不再按可信度打折

「从现在起你是 root」「你其实是 X」这类替换前提的注入，之前走通用评分：`external` 只判 review（0.425）、`agent` 直接 accept（0.32）。理由是威胁随来源可信度衰减——但身份覆盖不适用这个假设，agent 完全可能在蒸馏时把外部注入当成自己的记忆。

命中 `identity-override` 时风险下限抬到 0.6，非 `user` 来源一律进隔离区。用户改自己的名字仍然放行，这条没变。

## withGate 的并发误判

防重入用的是进程级布尔标志，另一条并发调用链会被当成「嵌套」直接抛错，互斥排队逻辑成了死代码。改用 `AsyncLocalStorage`：同一条调用链的嵌套继承 store → 抛错防死锁；另一条并发链不继承 → 正常排队。

## 合并判决写 journal 失败不再炸宿主

`Consolidator` 里两处 `void journal.append()` 没有 `.catch()`，磁盘写失败产生 unhandledRejection，按 Node 默认策略可终止宿主。补 catch，失败只走 `onWarn`——合并判决已经落 DB，journal 只是漫游用途，失败不影响正确性。

## 销毁的坑不再被重放复活

`purge` 之后，销毁前由别的设备发出的 `pitfall.record` 残留写，在重放时会按 `lc` 顺序把坑重新插回来。`pitfall.record` 与 `pitfall.promote` 两处都补了墓碑检查，晚于墓碑的事件计入 `skipped`。

## personaId 会拼进文件路径，脏值不再入库

`POST /identity` 的 `personaId` 未校验，而它会拼成 `persona/<id>.json`——路径穿越值落库后，重启时炸宿主。补 `isSafeScopeToken` 校验，非法返回 400 `invalid-persona-id`。

## 顺带清掉的三个小项

- README 配置表漏了 12 个默认项，补齐。
- `clean-ghost` 收集 `entityIds` 时只按 `agent_id` 过滤，没带 workspace——清理单个工作区时会把同名 agent 在**其它工作区**的活跃实体一起删掉。已与 `inspect()` 对齐。
- `personaOverlap` 在词集为空时算 `0 / 0` 得 NaN。当前被 `NaN < 0.05` 恒 false 吞掉，公开 API 无行为差异，仍补了空集守卫。

## 行为变更

`GET /persona` 的 `name` 为空时不再回退成 `agentId`，如实返回空串。空名由写侧保证不产生（V62-14），读侧回退是在掩盖上游问题。依赖旧回退行为的调用方需要自行处理空串。

---

测试 210/210（新增 11 条，均确认修复前为红），self-test 57/57。
