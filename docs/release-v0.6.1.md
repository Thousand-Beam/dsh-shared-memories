# v0.6.1

终审报告第三批。三个 P1、五个 P2，都是多设备漫游和隔离区这条线上的硬伤。

## 跨设备同 subject 双建实体不再撞唯一索引

两台设备各自建了一条内容相同的记忆，重放时撞上内容唯一索引（`uq_entity_identity`），事务回滚，整机掉进只读，而且每次重试都会再炸一次。

现在重放遇到同 `content_hash` 的实体先查已有记录：有就合并到那一条（版本、遗忘、合并都跟着归一），没有再插入。冲突目标也从 `entity_id` 主键改成了真正的唯一索引 `(workspace_id, agent_id, content_hash)`。

## 校验通道不再用字符串读快照文件

恢复校验之前用 UTF-8 字符串读快照文件再算哈希，二进制文件被往返破坏、超过 8MB 直接 `maxBuffer` 超限，都会被误判成 `snapshot-corrupt` 永久降级——而快照预算明明是 256MB。

现在走 `execFile` 的二进制模式，`maxBuffer` 提到 256MB，哈希直接对 Buffer 算，不再过字符串。

## purge 期间并发写入不丢

销毁会改写 journal 文件，改写期间其它路径的新写入会被 `rename` 静默覆盖。查下来销毁的入口其实已经包在 `journal.withGate` 里了（v0.5.5 加的），只是没测试锁定。补了一条并发测试：销毁在写闸门内完成，期间挂起的写入一条都不丢。

## 情绪标签从 8 个扩到 12 个

`fear` / `surprise` / `gratitude` / `loneliness` 这四个标签之前会被静默置 null——蒸馏端认 12 个，落库校验只认 8 个，三层各自为政。现在 `shared/types.ts` 是唯一权威源，蒸馏、落库、召回、UI 全用它。

## 隔离区裁决补归属校验和跨设备漫游

批准 / 销毁之前不校验归属，任何会话拿个 id 就能改别人的隔离条目；判决也不写 journal，换机后隔离区停在 pending。现在两个动作都带 `workspace_id + agent_id` 校验，判决走 `quarantine.approve` / `quarantine.destroy` 两条 journal 记录漫游。

## 隔离内容不再回流蒸馏

导入时被隔离的条目之前 `continue` 不写树，但蒸馏分支用原始全量拼 transcript，隔离内容照样进蒸馏管线。现在只拿放行的条目拼输入。

## 合并判决跨设备漫游

夜间整理合并两条记忆的判决之前只改本机库，不写 journal，换机后 loser 又活回来。现在合并写 `entity.merge` 记录，重放时还原 merged 状态、关掉 loser 的版本、补上 keeper 的 supersedes。

## 清理了约 30 个死配置项

配置面板里暴露了一批运行时不生效的字段：多路召回权重、遗忘曲线、夜间整理、人格位移上限、冲突分支数、隔离 strict、蒸馏模型等。删了整文件死代码 `agent-registry.ts`，接上了 `shutdown` / `manual` 两个触发开关（之前关了也不生效），其余在描述里标注「暂未生效」，不再装成能用。

---

测试 184/184，self-test 57/57。
