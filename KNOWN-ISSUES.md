# 已知问题 / 保留声明

> 本文记录 dsh-shared-memories 在持续自测中，经过评估后**有意保留**或**已修复**的已知项。
> 已修复的写清修复方式；保留的写清触发条件、影响面、以及为什么不修。

## 1. 跨设备时钟偏移导致 purge 复活（已修复：Lamport 逻辑时钟）
- 位置：`src/shared/journal.ts`（`JournalRecord.lc` 字段 + `readMerged()` 排序键）、`src/host/snapshot/restore.ts`（agent.purge 墓碑重放）。
- 修复：每条 journal 记录带单调递增的 `lc`（Lamport 逻辑时钟）；`Journal.open()` 恢复本设备 seq 后遍历所有设备最后一条记录对齐最大 lc 水位；`readMerged()` 排序键改为 `(lc, at, device, seq)`，旧记录（lc 缺失）回退用 0 + 墙钟。purge 墓碑本身也带 `lc`（`appendTombstone` 在改写 journal 前先扫全 journal 最大 lc，墓碑取 max+1）；`Journal.realignClock()` 让 pull 到远端后重新对齐水位。墓碑 lc 压过所有已落盘记录，replay 时墓碑最后执行、把之前重放出的 agent 记录删掉，杜绝复活。
- 验证：`test/journal.spec.ts`「Lamport 墓碑：跨设备墙钟漂移时墓碑仍先于复活记录」+「realignClock：pull 到远端后重新对齐 Lamport 水位」；`test/purge.spec.ts` 墓碑测试断言墓碑 lc 压过现有记录 + 新增「P0-1 回归：真实落盘墓碑（seq=1）能进重放流并删掉另一设备的记忆」端到端测试。
- 已知边界（多设备实验性）：墓碑 `lc = 本机 purge 时 scanJournalMaxLc + 1`，它保证压过「本机 purge 时刻之前、已同步到本机的所有记录」。但压不过「**其他设备在本机 purge 之后、且尚未同步到墓碑之前继续写入**」的记录——那些记录从别的设备本地计数继续增长，合并后 lc 可能大于墓碑，replay 时排在墓碑之后把已销毁 agent 复活。彻底解法需要「删除向量时钟 / 语义合并层」或「哨兵 lc（恒排最后）」；但哨兵 lc 会与「purge 后 realignClock 让本机新写入排在墓碑之后、不被误删」的语义冲突（本机 re-bind 的新记忆 lc < MAX_SAFE_INTEGER，会被哨兵墓碑一并抹掉）。两者不可兼得，当前选择「墓碑压过已落盘 + purge 后 realignClock 保护本机新写入」，把「其他设备并发未来」标记为多设备实验性的已知边界。

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

## 4. readAgentId / readSessionId 未做 SCOPE_TOKEN 校验（已修复：purge 入口 + persona 文件删除加校验）
- 位置：`src/index.ts`（readAgentId / readSessionId）。
- 说明：这两个函数只负责从事件负载里「挖」id，不做格式校验。但 id 进入的敏感路径已加防护：SQL 全部参数化、文件删除路径在 `src/host/memory/purge.ts` 的 `dropSessionLogs` 用 `bareSessionId()` 归一化后**完全相等**匹配（绝不做前缀/模糊匹配，杜绝路径穿越）、作用域构造在 `src/shared/scope.ts` 有 SCOPE_TOKEN 校验。
- 修复（v0.3.6）：`src/shared/scope.ts` 新增 `isSafeScopeToken()`；`src/host/http/routes.ts` 的 `/purge` 入口对 agentId/personaId 都过 `isSafeScopeToken`（非法即 400 拒绝执行）；`src/host/memory/purge.ts` 的 `scrubDerivedState` 在删 `persona/<agentId>.json` 前也过 `isSafeScopeToken`。`test/scope-leak.spec.ts` 新增「isSafeScopeToken：拒绝路径穿越与非法字符」测试。
- 剩余：readAgentId/readSessionId 本身仍不做校验（它们只是「挖 id」，不进入路径拼接），真正的路径拼接点在 purge/scrub 已全覆盖。

## 5. schema 参数 host 校验缺失（评估：需宿主配合，暂缓）
- 说明：部分工具入参的 `host` 字段未做宿主级来源校验。
- 不修原因：需要宿主侧提供可验证的来源标识，插件单独无法完成；已记录，待宿主 API 明确后再补。

## 6. snapshot capture 与 commit 之间的写闸门（已修复）
- 位置：`src/shared/journal.ts`（`withGate()`）、`src/index.ts`（snapshotNow）。
- 修复：给 Journal 加 `withGate(fn)`，快照流程先 `journal.flush()` 再在闸门内执行 capture+commit，闸门期间 `#appendOne` 挂起。杜绝 manifest 记录的 sha256 与 `git add -A` 提交内容脱节（P0-3）。v0.3.6 补：`withGate` 加 `#mutex` 互斥锁 + 嵌套调用直接抛错（防死锁）；purge 处理器也走 `journal.flush()` + `journal.withGate()`，让「purge 改 journal」与「快照 capture」互斥。
- 验证：`test/journal.spec.ts`「写闸门：withGate 执行期间 append 挂起，释放后按顺序落盘」+「withGate：嵌套调用直接抛错，防止死锁」。

## 7. 「彻底销毁」不重写 Git 历史（已知边界，插件不做）
- 位置：`src/host/memory/purge.ts`（purgeAgent 全程无 git 调用）。
- 说明：purge 删的是工作副本里的 memory.db 记录、journal、会话日志，但**不动 `.git` 里已 commit 的 blob，也不动已 push 到远端的对象**。已进入 git 快照的记忆/人格/会话，仍能被 `git log -p`、clone、或平台缓存翻出来「复活」。
- 影响：对「AI 记忆/人格」这类敏感个人数据，这是删除不彻底；真要从仓库根除需要 `git filter-repo` + force push + 请平台清缓存，本插件不做、也做不到保证。
- 处理：README 能力 13 已明确标注「不含 Git 历史」，安全边界段有完整警告。用户若要彻底根除，需在插件外自行执行历史重写。

## 8. 删除语义对宿主文件/API 深度耦合（结构性风险，已收敛但未根除）
- 说明：让一条会话「消失」当前分散在多个宿主机制上——前端 archiveSession 归档（内存态）、删会话日志（重启后 header 索引扫不到）、journal 墓碑（replay 时清记忆）。插件没有宿主级 `deleteSession` API 可调用，只能「停止直接改共享状态 + 依赖宿主原生机制」，这正是幽灵 bug 的根因（插件曾绕过所有者直接改 storages/）。
- 已收敛：v0.3.4 起 purge 不再删投影缓存与 workspace 记账（`dropProjectionCache`/`pruneWorkspaceRegistry` 已删，连带删除了整个 `session-artifacts.ts` 与 routes 里的 `removeSession` 路径）；`test/architecture.spec.ts` 焊死「插件代码不得写 storages/」。
- 剩余风险：宿主仍在 rc 阶段、header 索引等内部实现未来可能变动，届时「靠删日志让索引扫不到」可能再次失效。根治需宿主提供 `deleteSession` 级 API，插件只调用不伸手。

## 9. agent/disposed 关机快照 fire-and-forget（评估：暂缓，本地 commit 已同步）
- 位置：`src/index.ts`（agent/disposed 处理器 `void snapshotNow('shutdown')`）。
- 说明：关机快照是 `void` 触发，事件处理器立即返回，不 await 快照完成。但 `snapshotNow` 内部先 `journal.flush()`（把队列清空落盘）再 `withGate` 内 capture+commit，本地 git commit 是同步的；`fire-and-forget` 丢的只有最后一步 `push`（网络），下次开机/定时同步会补 push。
- 影响：关机瞬间若进程被强杀，可能少一次「关机快照」的 push，但记忆数据本身已 append 落盘、本地 commit 已完成，不丢记忆。
- 不修原因：宿主在 agent/disposed 后不保证给插件 await 的机会；强行阻塞事件处理器可能拖住宿主退出。已由「append 同步落盘 + 本地 commit」兜底。

## 10. 快照 sha256 校验可能误伤正常写入（评估：暂缓，需查证触发路径）
- 位置：`src/host/snapshot/restore.ts`（verifySnapshotHashes）。
- 说明：快照 manifest 记录的 sha256 是 capture 时刻的文件内容；若 journal 在快照后正常 append 变长（append-only 允许，`allowedToGrow` 只对 `journal/` 前缀放行），sha256 会不一致。当前实现只对非 journal 文件做严格比对，journal 走「允许增长」路径。
- 影响：理论上 memory.db 等非 journal 文件若在快照后被正常写入，会被误判「快照损坏」而降级；但 memory.db 不进快照清单（`#collectFiles` 跳过 `.db`），persona/state 等文件在快照后不写，实际触发面极窄。
- 不修原因：需要完整复现「快照后、校验前有合法非 journal 写入」的路径才能对症下药，当前未观测到，暂记。

## 11. HTTP 面无 CSRF / Origin 防御（评估：暂缓，宿主 webServer 层职责）
- 位置：`src/host/http/routes.ts`（token-write policy）。
- 说明：插件 HTTP 路由靠 `barrier.assertWritable`（token 校验）授权，但没有校验请求的 Origin/Referer。恶意网页若拿到 token 或能触发浏览器自动带凭据的请求，可能跨站调用 purge 等写接口。
- 影响：本插件路由挂在宿主 webServer 下，浏览器同源策略 + 宿主 CORS/鉴权是第一道防线；插件再加 Origin 校验可能误伤宿主不同端口/Electron 场景。
- 不修原因：这是宿主 webServer 层的通用职责（同源/CORS），插件层重复实现易误伤，且需要宿主提供可信来源标识后才能正确判断。
