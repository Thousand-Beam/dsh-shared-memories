# 已知问题 / 保留声明

> 本文记录 dsh-shared-memories 在持续自测中，经过评估后**有意保留**或**已修复**的已知项。
> 已修复的写清修复方式；保留的写清触发条件、影响面、以及为什么不修。

## 1. 跨设备时钟偏移导致 purge 复活（已修复：Lamport 逻辑时钟）
- 位置：`src/shared/journal.ts`（`JournalRecord.lc` 字段 + `readMerged()` 排序键）、`src/host/snapshot/restore.ts`（agent.purge 墓碑重放）。
- 修复：每条 journal 记录带单调递增的 `lc`（Lamport 逻辑时钟）；`Journal.open()` 恢复本设备 seq 后遍历所有设备最后一条记录对齐最大 lc 水位；`readMerged()` 排序键改为 `(lc, at, device, seq)`，旧记录（lc 缺失）回退用 0 + 墙钟。跨设备时墓碑的 lc 必然小于其后写的事件，墓碑先重放，杜绝复活。
- 验证：`test/journal.spec.ts` 新增「Lamport 墓碑：跨设备墙钟漂移时墓碑仍先于复活记录」测试。

## 2. 冷启动 journal 全量重放随规模线性变慢（评估：暂缓，需状态快照层）
- 位置：`src/host/snapshot/restore.ts`（verifyAndReplay 全量 `readMerged()` + `ReplayApplier.apply` 重放到本机 memory.db）。
- 背景：memory.db **不进 git 快照**（`src/host/snapshot/engine.ts` 的 `#collectFiles` 显式跳过 `.db`/`.db-wal`），只同步 journal + state + persona。因此本机 memory.db 必须靠 journal 逐条重放重建。
- 触发：journal 无限 append-only 增长，冷启动重放时间线性变长。
- 影响：当前单机 6197 行重放是毫秒级，纯本地模式为主，远未到瓶颈。
- 不修原因：真正的 checkpoint（跳过旧事件）需要「状态快照层」——把 memory.db 的折叠状态导出成 git 可同步的格式，冷启动时「加载折叠状态 + 重放增量」。直接按 manifest 的 `journalSeq` 水位跳过 replay 有**静默丢记忆**风险：跨设备时本机 memory.db 是停机前的旧状态，跳过「快照后、本机停机前」其它设备写的事件会导致数据丢失。已保留 `readMerged({ sinceSeq })` 参数作为无害基础设施，待状态快照层落地后启用。

## 3. 同毫秒、不同文本的版本会留下零长区间（评估：暂不修）
- 位置：`src/host/memory/timetree.ts`（分支 B/C，at === valid_from 且 text 不同）。
- 触发：两条不同文本的记忆在**同一毫秒**写入同一 entity。
- 影响：产生一个 valid_from == valid_until 的零长版本，查询语义仍正确（新版本从该时刻起生效），只是历史里多一条空区间。
- 不修原因：实测把 `at >= valid_from` 改成 `at > valid_from` 无法根治（会落入分支 C，仍 truncate 到零长），需更大重构，风险大于收益。

## 4. readAgentId / readSessionId 未做 SCOPE_TOKEN 校验（评估：已有双重防线，不加）
- 位置：`src/index.ts`（readAgentId / readSessionId）。
- 说明：这两个函数只负责从事件负载里「挖」id，不做格式校验。但 id 进入的所有敏感路径已有防护：SQL 全部参数化、文件路径在 `src/host/memory/session-artifacts.ts` 有 basename 穿越守卫、作用域构造在 `src/shared/scope.ts` 有 SCOPE_TOKEN 校验。
- 不修原因：再加一层是「防御纵深」的第三道，边际收益低，且可能误伤未来合法的 id 形态。

## 5. schema 参数 host 校验缺失（评估：需宿主配合，暂缓）
- 说明：部分工具入参的 `host` 字段未做宿主级来源校验。
- 不修原因：需要宿主侧提供可验证的来源标识，插件单独无法完成；已记录，待宿主 API 明确后再补。

## 6. snapshot capture 与 commit 之间的写闸门（已修复）
- 位置：`src/shared/journal.ts`（`withGate()`）、`src/index.ts`（snapshotNow）。
- 修复：给 Journal 加 `withGate(fn)`，快照流程先 `journal.flush()` 再在闸门内执行 capture+commit，闸门期间 `#appendOne` 挂起。杜绝 manifest 记录的 sha256 与 `git add -A` 提交内容脱节（P0-3）。
- 验证：`test/journal.spec.ts` 新增「写闸门：withGate 执行期间 append 挂起，释放后按顺序落盘」测试。
