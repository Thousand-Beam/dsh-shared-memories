# 更新日志

## 0.6.4 — 2026-11-23

### 修复

**P1**

- 快照回灌覆盖 journal 重放出的新画像 / 新人格：回灌改用快照捕获时刻，画像与人格的 upsert 加时间守卫

**P2**

- `package.json` 带 BOM 导致 `npm run build` 失败、产物缺 `lib/client.js`
- 防投毒：身份覆盖类注入命中时风险下限 0.6，非用户来源进隔离区
- `withGate` 把并发调用误判成嵌套，直接抛错
- Consolidator 的 `journal.append()` 没有 catch，写失败会终止宿主
- `pitfall.record` / `pitfall.promote` 重放没有墓碑守卫，purge 后会被插回来

**P3**

- `POST /identity` 的 `personaId` 未校验
- README 配置表漏 12 项；`clean-ghost` 跨 workspace 误删；`personaOverlap` 空集产生 NaN

### 行为变更

`GET /persona` 的 `name` 为空时返回空串，不再回退成 `agentId`。

### 验证

`npm test` 210/210 · `self-test` 57/57 · `lib/client.js` 211,096 bytes

### 已知问题

测试 harness 用随机端口起服务，可能命中 undici 的黑名单端口（6000、6665–6669 等）导致偶发 `TypeError: Error: bad port`，重跑即过。非本版引入。

## 0.6.3 及更早

见 git 标签与提交历史（`git log v0.6.3`）。
