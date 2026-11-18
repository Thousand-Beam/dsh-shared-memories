# 已知问题 / 保留声明

> 本文记录 dsh-shared-memories 在 2026-11-18 全功能自测收官时，经过评估后**有意保留**的已知项。
> 它们要么是单机本地场景下不会触发的理论边界，要么已有其它防线覆盖，要么需要宿主侧配合才能修复。
> 保留不代表缺陷：每一条都写清了触发条件、影响面、以及为什么不修。

## 1. 跨设备时钟偏移可能导致 purge 复活（评估：暂不修）
- 位置：`src/host/snapshot/restore.ts`（agent.purge 墓碑重放）、`src/shared/journal.ts`（readMerged 按 at/device/seq 排序）。
- 触发：同一工作区在**多台机器**上写 journal，且某台时钟比墓碑超前；墓碑排序在「未来时间」记录之前时，那条记录会在墓碑之后重放，等于复活。
- 影响：仅跨设备同步且时钟不准时可能发生。本插件当前是**本地单机**运行，所有 journal 由同一进程、同一时钟写入，实际不会触发。
- 不修原因：根治需要给 journal 引入跨设备的单调递增序列，改动面大、收益低。若未来支持多机同步再处理。

## 2. 同毫秒、不同文本的版本会留下零长区间（评估：暂不修）
- 位置：`src/host/memory/timetree.ts`（分支 B/C，at === valid_from 且 text 不同）。
- 触发：两条不同文本的记忆在**同一毫秒**写入同一 entity。
- 影响：产生一个 valid_from == valid_until 的零长版本，查询语义仍正确（新版本从该时刻起生效），只是历史里多一条空区间。
- 不修原因：实测把 `at >= valid_from` 改成 `at > valid_from` 无法根治（会落入分支 C，仍 truncate 到零长），需更大重构，风险大于收益。

## 3. readAgentId / readSessionId 未做 SCOPE_TOKEN 校验（评估：已有双重防线，不加）
- 位置：`src/index.ts`（readAgentId / readSessionId）。
- 说明：这两个函数只负责从事件负载里「挖」id，不做格式校验。但 id 进入的所有敏感路径已有防护：SQL 全部参数化、文件路径在 `src/host/memory/session-artifacts.ts` 有 basename 穿越守卫、作用域构造在 `src/shared/scope.ts` 有 SCOPE_TOKEN 校验。
- 不修原因：再加一层是「防御纵深」的第三道，边际收益低，且可能误伤未来合法的 id 形态。

## 4. schema 参数 host 校验缺失（评估：需宿主配合，暂缓）
- 说明：部分工具入参的 `host` 字段未做宿主级来源校验。
- 不修原因：需要宿主侧提供可验证的来源标识，插件单独无法完成；已记录，待宿主 API 明确后再补。
