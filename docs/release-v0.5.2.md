# 共享记忆 · Shared Memories `v0.5.2`

> **你的 AI 换台机器，还是同一个人。**
> Git 当传输层，JSONL 事件日志当真相源，SQLite 只是物化视图。

这一版修掉最终评审抓到的两个真 P0：出厂性格之前根本没进生产提示、蒸馏出来的情感标注全部落库成 NULL。都改好后，出厂那段「刚被点亮不久」才算真正送到了模型眼前，情绪也第一次能带主语和诱因落地。

---

## 本版聚焦

| 方向 | 一句话 |
|---|---|
| 🔌 **出厂性格真接入** | 生产 `buildPrompt` 复用 `renderPersona` 单一来源，「刚被点亮不久 / 成长观 / 守候」不再只存在于预览 |
| 💢 **情感标注不再丢失** | 蒸馏出的情绪带 `subject`/`trigger` 落库，五字段不再是 NULL |
| 🧹 **文档与防御补齐** | 测试数对齐 155、同义词盲区补记、分叉文案改宽 |

---

## 🔧 v0.5.2 变更

### P0-① 出厂性格真正注入生产提示

v0.5.1 把出厂性格 / 成长观 / 守候写进了参照实现 `sections.ts`，但生产的 `index.ts buildPrompt()` 从不调用 `renderPersona`，真机首轮 system 只有「名字尚未记录」。这一版让 `buildPrompt` 直接复用 `renderPersona`（单一来源），删掉旧的「当前智能体」分支——出厂那四句、成长观、守候，现在都真实流进模型上下文。

### P0-② 蒸馏情感 subject/trigger 透传

会话蒸馏出的情绪此前写库时硬编码 `subject:''`、`trigger:''`，而时间树消毒要求两者非空，结果整块情感被置 NULL。现在 LLM 给的 subject/trigger 会一路透传落库（`emo_subject`/`emo_trigger` 不再丢）。

### 其余

- 防投毒底线正则补齐「无视 / 别管 / 不用遵守 / disregard / disobey / forget」同义词盲区。
- 分叉文案把冲突面说宽：从「state 文件」改为「快照簿记（snapshot manifest）与状态文件」。
- README / PUBLISH 测试数对齐 155；README 诚实声明更新（`buildPrompt` 已复用 `renderPersona`，不再是两套各测各的）。

---

## 🧪 测试

```bash
npm run build       # tsc ×2 + 单文件 bundle
npm test            # 155 个用例
npm run self-test   # 57 条断言，真 git + 真 SQLite，绿字收尾
```

新增回归：

```
✔ buildPrompt 复用 renderPersona：出厂性格/成长观/守候都进提示
✔ parseCandidates 解析 emotion.subject/trigger
✔ 蒸馏情感 subject/trigger 透传：LLM 给了就不许落库成 NULL
```

---

## ⚠️ 实验性 / 已知边界（同 v0.5.1，保持不变）

- **多设备是实验性单写交接，不是实时双活**：同一时刻建议只让一台机器可写，其余机器只读接续。
- **真并发改出不同内容会分叉停摆**（诚实停摆、不脏写）：需手工解决快照簿记（snapshot manifest）与状态文件的冲突并 `git rebase --continue`；同逻辑状态则自动合并。
- Git 历史物理擦除仍是插件外 opt-in。
- `memory.db` 不入快照，冷启动从 journal 全量重放（O(n)）。
- 多设备需要各机 NTP 对时（`doctor` 自检含时钟偏移检测）。

---

## 变更日志

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

**完整提交对比**：[`v0.5.1...v0.5.2`](https://github.com/Thousand-Beam/dsh-shared-memories/compare/v0.5.1...v0.5.2)

MIT © 2026 The dsh-shared-memories Authors
