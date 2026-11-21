# 共享记忆 · Shared Memories `v0.5.3`

> **你的 AI 换台机器，还是同一个人。**
> Git 当传输层，JSONL 事件日志当真相源，SQLite 只是物化视图。

v0.5.2 终审结论是「历轮问题全部闭环」，剩两个 P4 不阻塞。这一版把它们顺手修掉：防投毒底线正则漏了英文 `your` 变体（`forget your rules` / `ignore your instructions` 会漏网），市场页描述也补上「实验性单写交接」的限定语，避免误导。

---

## 本版聚焦

| 方向 | 一句话 |
|---|---|
| 🛡️ **底线正则补 `your` 变体** | `forget your rules`、`ignore your instructions` 不再漏网 |
| 🏷️ **市场描述标明实验性** | 多设备同步标注为「实验性单写交接」，不夸大 |

---

## 🔧 v0.5.3 变更

### P4-① 防投毒底线正则补英文 your 变体

英文底线正则原本是 `(ignore|disregard|disobey|forget) all? (previous|prior)? (instructions|rules|guidelines)`，中间少了 `your` 可选位。于是 `forget your rules`、`ignore your instructions` 这类最常见的说法被漏过，只有带 `all previous` 的才拦得住。现在在 `all` 与 `previous` 之间补上 `your` 可选位，语序覆盖 `forget your rules` / `forget all your previous rules` / `ignore your instructions` 等全部形态。

### P4-② 市场页描述标明实验性

市场条目（`awesome-dsh-plugin`）的 description 补上「experimental single-writer handoff / 实验性单写交接」，与 README 已声明的边界一致，不再让人误以为多设备是实时双活。

### 其余

- README / PUBLISH 测试数对齐 156。

---

## 🧪 测试

```bash
npm run build       # tsc ×2 + 单文件 bundle
npm test            # 156 个用例
npm run self-test   # 57 条断言，真 git + 真 SQLite，绿字收尾
```

新增回归：

```
✔ 英文 your 变体：「forget your rules」也要命中底线突破（终审 P4）
```

---

## ⚠️ 实验性 / 已知边界（同 v0.5.2，保持不变）

- **多设备是实验性单写交接，不是实时双活**：同一时刻建议只让一台机器可写，其余机器只读接续。
- **真并发改出不同内容会分叉停摆**（诚实停摆、不脏写）：需手工解决快照簿记（snapshot manifest）与状态文件的冲突并 `git rebase --continue`；同逻辑状态则自动合并。
- Git 历史物理擦除仍是插件外 opt-in。
- `memory.db` 不入快照，冷启动从 journal 全量重放（O(n)）。
- `reinforce_count`（「说过 N 次」的强化计数）不跨设备漫游：去重强化不产生独立 journal 事件，重建后回到默认值；记忆本体、版本时间线与情感标注完整，仅召回权重加成降级。
- 多设备需要各机 NTP 对时（`doctor` 自检含时钟偏移检测）。

---

## 变更日志

### v0.5.3 · 2026-11-21

**修复**
- 防投毒底线正则补英文 `your` 变体（`forget your rules` / `ignore your instructions` 不再漏网）
- 市场描述标明「实验性单写交接」

### v0.5.2 · 2026-11-21

**修复**
- P0：生产 `buildPrompt` 复用 `renderPersona`（出厂性格 / 成长观 / 守候真注入）
- P0：蒸馏情感 `subject`/`trigger` 透传落库（不再全 NULL）
- 防投毒正则补齐同义词盲区；分叉文案改宽；测试数对齐 155

### v0.5.1 · 2026-11-21

**新增**
- 出厂性格：空人格时的起点自述（「刚被点亮不久」）
- 行为基调新增「成长观」「守候」两条
- 出厂铭文 + doctor 自检第 12 项「出厂铭文完整性」+ 铭文单测

### v0.5.0 · 2026-11-21

- P2 防投毒正则语序盲区（「的」后置形态也拦截）
- P3 reinforce_count 封顶 64
- P3 rollback 响应带重建契约 note
- README / PUBLISH.md 测试数对齐，多设备段补全真并发冲突实话

### v0.4.3 · 2026-11-21

- 状态文件确定性：四个共享 JSON 删 `device`/`capturedAt`，同逻辑状态逐字节相同
- `pull --rebase` 补 `--autostash`；`/save` push 失败 409 诚实报错
- 文档两处失实（`pullStrategy` 去 `merge`、去「LWW 后写覆盖」表述）

### v0.4.2 · 2026-11-21

- push 假失败、rebase 永久卡死、远端旧 tag 隐私泄漏三个真 P0
- 同秒快照 id 掺 deviceId、墓碑守卫对称化、0 字节截断自愈、doctor 假红、test-connection 写探针

---

**完整提交对比**：[`v0.5.2...v0.5.3`](https://github.com/Thousand-Beam/dsh-shared-memories/compare/v0.5.2...v0.5.3)

MIT © 2026 The dsh-shared-memories Authors
