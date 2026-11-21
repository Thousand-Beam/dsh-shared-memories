# dsh-shared-memories v0.5.5

> **彻底销毁会话后，重启不再复活。**

## 本版聚焦

| 项 | 内容 |
| --- | --- |
| 核心修复 | 「彻底销毁会话」现在会把会话 id 从宿主工作区记账（workspace registry）中真正摘除，重启后侧栏不再重新出现这一行 |
| 回归测试 | 新增 2 条（detach 摘除 + 服务缺失/异常安全），单测 160/160、self-test 57/57 |
| 无破坏性变更 | 接口、快照格式、存储 schema 均未变 |

## 问题背景

上一版（v0.5.4 及更早）的「彻底销毁」只做了三件事：

1. 删除插件的记忆库、journal 与墓碑；
2. 删除宿主侧的会话日志目录（`~/.dsh/sessions/…`）；
3. 调用宿主的「归档」把侧栏那一行藏起来。

但宿主的 dsh-workspace 有一条设计：**归档只藏不摘**——归档的会话会保留它在 `sessionIds` 记账数组里的槽位，这样「取消归档」时才能恢复到原来的位置。于是「销毁 → 归档」之后，会话 id 仍然登记在工作区记账里，宿主重启重新扫描时，那一行又回到侧栏。

## 修复内容

销毁流程的最后一步现在会调用宿主 `workspaceRegistry` 服务的 `detachSession(sessionId)`，把会话 id 从工作区记账数组中真正摘除：

- 走宿主自己的写路径，不直接改磁盘上的 workspace.json（避免与宿主内存态打架）；
- `detachSession` 幂等：重复调用不会出错；
- 服务缺失或抛错时仅记录告警，不影响销毁主流程；
- 服务通过 `host.inject(['workspaceRegistry'])` 局部注入获取，老宿主自动回退。

## 变更文件

- `src/index.ts`：新增 `detachSessionFromWorkspaces()`（导出）；purge 流程收尾时摘除宿主工作区记账；局部注入 `workspaceRegistry`。
- `test/detach-host.spec.ts`：新增 2 条回归测试。

## 测试

- 单元/集成测试：**160/160** 通过
- self-test：**57/57** 通过

## 变更日志

- v0.5.5 — 彻底销毁后从宿主工作区记账 detach 会话，重启不再复活（`d7e5ca6`）
- v0.5.4 — 分叉时告知最近共同祖先快照 id；重启不再误判降级（校验基准改为快照 git 对象）
- v0.5.3 — 底线正则补 your 变体；市场描述标明实验性
- v0.5.2 — 出厂性格真接入 buildPrompt；蒸馏情感 subject/trigger 透传
- v0.5.1 — 出厂性格定型、成长观与守候基调、出厂铭文与自检
- v0.5.0 — 投毒正则语序盲区、reinforce 封顶、rollback 重建契约、分叉自救实话

## 版本对比

- [v0.5.4…v0.5.5](https://github.com/Thousand-Beam/dsh-shared-memories/compare/v0.5.4...v0.5.5)
- [v0.5.3…v0.5.4](https://github.com/Thousand-Beam/dsh-shared-memories/compare/v0.5.3...v0.5.4)
