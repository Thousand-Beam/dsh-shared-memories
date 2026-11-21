/**
 * dsh-shared-memories — 控制台样式（client/styles.ts）
 * ---------------------------------------------------------------------------
 * 为什么是"字符串 + 运行时注入 <style>"，而不是 `.css` 文件或 Tailwind：
 *
 *   1. 客户端产物由 `scripts/wrap-client.mjs` 用 esbuild 打成**一个 CJS 文件**塞进
 *      宿主的 `__ModuleLoader__`。CSS import 会变成第二个 output，外壳不管它，
 *      样式就静默丢了——这正是上一版真机"裸奔"的原因；
 *   2. 宿主页面不保证加载 Tailwind，CDN 更不行（离线 + 内网环境直接白给）；
 *   3. 一个 `<style id>` 注入，热重载时靠 id 去重，不重复堆 DOM。
 *
 * 配色策略：**只借宿主的主题令牌，不自己发明颜色**。
 * `--dsw-alias-*` 是宿主 Theme 服务暴露的变量（浅/深色由宿主管），
 * 每个变量都带一个兜底值，所以：
 *   • 在宿主里 → 跟随宿主主题，深浅色自动正确；
 *   • 在本地预览（没有宿主令牌）→ 落到兜底值，`.dark` 下自动切深色。
 */

/** 注入用的 id：既做去重键，也方便在 DevTools 里一眼找到这块样式。 */
export const CONSOLE_STYLE_ID = 'dsh-shared-memories/console.css'

export const CONSOLE_CSS = `
/* ── 设计令牌 ───────────────────────────────────────────────────────────── */
:root {
  --dsm-radius-lg: 18px;
  --dsm-radius: 14px;
  --dsm-radius-sm: 10px;

  --dsm-bg: var(--dsw-alias-bg-base, #f4f5f7);
  --dsm-surface: var(--dsw-alias-bg-layer-1, #ffffff);
  --dsm-surface-2: var(--dsw-alias-bg-layer-2, #f2f3f6);
  --dsm-surface-3: var(--dsw-alias-bg-layer-2, #e9ebf0);
  --dsm-overlay: var(--dsw-alias-bg-overlay, #ffffff);
  --dsm-sidebar: var(--dsw-specific-sidebar-fill, rgba(249, 250, 252, 0.9));

  --dsm-line: var(--dsw-alias-border-l1, rgba(17, 24, 39, 0.09));
  --dsm-line-strong: var(--dsw-alias-border-l2, rgba(17, 24, 39, 0.18));

  --dsm-text: var(--dsw-alias-label-primary, #111827);
  --dsm-text-2: var(--dsw-alias-label-secondary, #667085);
  --dsm-accent: var(--dsw-alias-brand-primary, #4f46e5);
  --dsm-ok: var(--dsw-alias-state-success-primary, #0f7b5f);
  --dsm-warn: var(--dsw-alias-state-warn-primary, #b25e09);
  --dsm-danger: var(--dsw-alias-state-error-primary, #c0362c);
  --dsm-idle: var(--dsw-alias-state-idle-primary, #98a2b3);

  --dsm-shadow-1: 0 1px 2px rgba(16, 24, 40, 0.05);
  --dsm-shadow-2: 0 1px 2px rgba(16, 24, 40, 0.05), 0 14px 34px -26px rgba(16, 24, 40, 0.5);
  --dsm-shadow-pop: 0 24px 60px -28px rgba(9, 13, 24, 0.55);

  /* 喜悦刻意给绿色（用户明确要求：焦虑橘、喜悦绿），不跟着"暖色系"走。 */
  --dsm-joy: #15803d;
  --dsm-anxiety: #c2410c;
  --dsm-frustration: #be123c;
  --dsm-pride: #7c3aed;
  --dsm-curiosity: #0369a1;
  --dsm-anger: #dc2626;
  --dsm-sadness: #2563eb;
  --dsm-neutral: #64748b;

  --dsm-font-mono: ui-monospace, SFMono-Regular, "Cascadia Code", Menlo, Consolas, monospace;
}

/* 深色：宿主有令牌时令牌优先（var 的第一顺位），没有时才用兜底值。 */
.dark,
[data-dsm-theme='dark'] {
  --dsm-bg: var(--dsw-alias-bg-base, #0d0f14);
  --dsm-surface: var(--dsw-alias-bg-layer-1, #16191f);
  --dsm-surface-2: var(--dsw-alias-bg-layer-2, #1d2129);
  --dsm-surface-3: var(--dsw-alias-bg-layer-2, #232833);
  --dsm-overlay: var(--dsw-alias-bg-overlay, #171b22);
  --dsm-sidebar: var(--dsw-specific-sidebar-fill, rgba(18, 21, 27, 0.92));

  --dsm-line: var(--dsw-alias-border-l1, rgba(255, 255, 255, 0.09));
  --dsm-line-strong: var(--dsw-alias-border-l2, rgba(255, 255, 255, 0.18));

  --dsm-text: var(--dsw-alias-label-primary, #e8eaee);
  --dsm-text-2: var(--dsw-alias-label-secondary, #9aa3b2);
  --dsm-accent: var(--dsw-alias-brand-primary, #8b8cf9);
  --dsm-ok: var(--dsw-alias-state-success-primary, #4ade9f);
  --dsm-warn: var(--dsw-alias-state-warn-primary, #f5b544);
  --dsm-danger: var(--dsw-alias-state-error-primary, #ff7a72);
  --dsm-idle: var(--dsw-alias-state-idle-primary, #7b8496);

  --dsm-shadow-1: 0 1px 2px rgba(0, 0, 0, 0.4);
  --dsm-shadow-2: 0 1px 2px rgba(0, 0, 0, 0.4), 0 18px 40px -30px rgba(0, 0, 0, 0.9);
  --dsm-shadow-pop: 0 28px 70px -30px rgba(0, 0, 0, 0.9);

  --dsm-joy: #4ade80;
  --dsm-anxiety: #fb923c;
  --dsm-frustration: #fb7185;
  --dsm-pride: #c4b5fd;
  --dsm-curiosity: #7dd3fc;
  --dsm-anger: #f87171;
  --dsm-sadness: #93c5fd;
  --dsm-neutral: #cbd5e1;
}

/* ── 骨架 ───────────────────────────────────────────────────────────────── */
.dsm-root {
  display: flex;
  height: 100%;
  min-height: 620px;
  background: var(--dsm-bg);
  color: var(--dsm-text);
  font-size: 14px;
  line-height: 1.55;
  font-family: inherit;
  -webkit-font-smoothing: antialiased;
  overflow: hidden;
}
.dsm-root *,
.dsm-root *::before,
.dsm-root *::after { box-sizing: border-box; }
.dsm-root button,
.dsm-root input,
.dsm-root select,
.dsm-root textarea { font: inherit; color: inherit; }
.dsm-root p, .dsm-root h1, .dsm-root h2, .dsm-root h3, .dsm-root h4 { margin: 0; }
.dsm-root ul, .dsm-root ol { margin: 0; padding: 0; list-style: none; }

/* ── 侧栏 ───────────────────────────────────────────────────────────────── */
.dsm-sidebar {
  width: 214px;
  flex: 0 0 214px;
  display: flex;
  flex-direction: column;
  gap: 6px;
  padding: 16px 12px 14px;
  border-right: 1px solid var(--dsm-line);
  background: var(--dsm-sidebar);
  backdrop-filter: blur(12px);
}
.dsm-brand { padding: 2px 8px 12px; }
.dsm-brand-title {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 14px;
  font-weight: 650;
  letter-spacing: 0.2px;
}
.dsm-brand-sub {
  margin-top: 3px;
  font-size: 11.5px;
  color: var(--dsm-text-2);
}
.dsm-brand-mark {
  display: grid;
  place-items: center;
  width: 24px;
  height: 24px;
  border-radius: 8px;
  background: color-mix(in srgb, var(--dsm-accent) 16%, transparent);
  color: var(--dsm-accent);
}

.dsm-nav {
  display: flex;
  align-items: center;
  gap: 9px;
  width: 100%;
  padding: 8px 10px;
  border: 1px solid transparent;
  border-radius: var(--dsm-radius-sm);
  background: transparent;
  color: var(--dsm-text-2);
  text-align: left;
  cursor: pointer;
  transition: background 140ms ease, color 140ms ease, border-color 140ms ease;
}
.dsm-nav:hover { background: var(--dsm-surface-2); color: var(--dsm-text); }
.dsm-nav[data-active='true'] {
  background: color-mix(in srgb, var(--dsm-accent) 12%, transparent);
  border-color: color-mix(in srgb, var(--dsm-accent) 26%, transparent);
  color: var(--dsm-accent);
  font-weight: 600;
}
.dsm-nav-icon { display: grid; place-items: center; width: 18px; height: 18px; flex: 0 0 18px; opacity: 0.9; }
.dsm-nav-text { min-width: 0; }
.dsm-nav-hint {
  display: block;
  font-size: 11px;
  font-weight: 400;
  color: var(--dsm-text-2);
  opacity: 0.85;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.dsm-sidebar-foot {
  margin-top: auto;
  padding: 10px 8px 0;
  border-top: 1px solid var(--dsm-line);
  font-size: 11px;
  line-height: 1.7;
  color: var(--dsm-text-2);
}

/* ── 主区 ───────────────────────────────────────────────────────────────── */
.dsm-main { display: flex; flex-direction: column; min-width: 0; flex: 1 1 auto; }
/* 注意 position/z-index：header 用了 backdrop-filter，它自己会形成一个
   层叠上下文；不显式抬高层级的话，DOM 里排在后面的 .dsm-content 会整块
   盖在 header 之上——下拉菜单就会"钻"到卡片下面去。 */
.dsm-header {
  position: relative;
  z-index: 40;
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 10px;
  padding: 12px 18px;
  border-bottom: 1px solid var(--dsm-line);
  background: color-mix(in srgb, var(--dsm-surface) 78%, transparent);
  backdrop-filter: blur(10px);
}
.dsm-content {
  flex: 1 1 auto;
  min-height: 0;
  overflow: auto;
  padding: 18px 20px 30px;
  scrollbar-width: thin;
}
.dsm-content::-webkit-scrollbar { width: 9px; height: 9px; }
.dsm-content::-webkit-scrollbar-thumb {
  background: var(--dsm-line-strong);
  border-radius: 99px;
  border: 2px solid transparent;
  background-clip: content-box;
}
.dsm-page { max-width: 880px; margin: 0 auto; display: flex; flex-direction: column; gap: 14px; }

/* ── 排版/通用 ──────────────────────────────────────────────────────────── */
.dsm-h1 { font-size: 17px; font-weight: 650; letter-spacing: 0.2px; }
.dsm-h2 { font-size: 14.5px; font-weight: 620; }
.dsm-h3 { font-size: 13px; font-weight: 600; }
.dsm-caption { font-size: 11.5px; color: var(--dsm-text-2); }
.dsm-muted { color: var(--dsm-text-2); }
.dsm-mono { font-family: var(--dsm-font-mono); font-size: 11.5px; letter-spacing: -0.1px; }
.dsm-num { font-variant-numeric: tabular-nums; }
.dsm-row { display: flex; align-items: center; gap: 8px; }
.dsm-row--wrap { flex-wrap: wrap; }
.dsm-row--between { justify-content: space-between; }
.dsm-col { display: flex; flex-direction: column; gap: 4px; }
.dsm-stack { display: flex; flex-direction: column; gap: 10px; }
.dsm-spacer { flex: 1 1 auto; }
.dsm-divider { height: 1px; background: var(--dsm-line); border: 0; margin: 4px 0; }
.dsm-truncate { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }

/* ── 按钮 ───────────────────────────────────────────────────────────────── */
.dsm-btn {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 6px;
  height: 32px;
  padding: 0 12px;
  border: 1px solid var(--dsm-line);
  border-radius: var(--dsm-radius-sm);
  background: var(--dsm-surface);
  color: var(--dsm-text);
  font-size: 12.5px;
  font-weight: 500;
  cursor: pointer;
  white-space: nowrap;
  transition: background 140ms ease, border-color 140ms ease, transform 80ms ease, box-shadow 140ms ease;
}
.dsm-btn:hover { border-color: var(--dsm-line-strong); box-shadow: var(--dsm-shadow-1); }
.dsm-btn:active { transform: translateY(0.5px); }
.dsm-btn:focus-visible { outline: 2px solid color-mix(in srgb, var(--dsm-accent) 55%, transparent); outline-offset: 1px; }
.dsm-btn:disabled { opacity: 0.45; cursor: not-allowed; box-shadow: none; }
.dsm-btn--primary {
  background: var(--dsm-accent);
  border-color: transparent;
  color: #fff;
}
.dsm-btn--primary:hover { filter: brightness(1.06); }
.dsm-btn--ghost { background: transparent; border-color: transparent; color: var(--dsm-text-2); }
.dsm-btn--ghost:hover { background: var(--dsm-surface-2); color: var(--dsm-text); }
.dsm-btn--danger { color: var(--dsm-danger); border-color: color-mix(in srgb, var(--dsm-danger) 35%, transparent); }
.dsm-btn--danger:hover { background: color-mix(in srgb, var(--dsm-danger) 10%, transparent); }
.dsm-btn--sm { height: 27px; padding: 0 9px; font-size: 11.5px; border-radius: 8px; }
.dsm-btn--block { width: 100%; }

/* ── 胶囊筛选 ───────────────────────────────────────────────────────────── */
.dsm-filter-block { display: flex; flex-direction: column; gap: 6px; }
.dsm-filter-label {
  font-size: 11px;
  font-weight: 600;
  letter-spacing: 0.6px;
  color: var(--dsm-text-2);
}
.dsm-pill-row { display: flex; flex-wrap: wrap; gap: 6px; }
.dsm-pill {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  height: 28px;
  padding: 0 12px;
  border: 1px solid var(--dsm-line);
  border-radius: 999px;
  background: var(--dsm-surface);
  color: var(--dsm-text-2);
  font-size: 12px;
  cursor: pointer;
  transition: all 140ms ease;
}
.dsm-pill:hover { border-color: var(--dsm-line-strong); color: var(--dsm-text); }
.dsm-pill[data-active='true'] {
  background: var(--dsm-accent);
  border-color: transparent;
  color: #fff;
  font-weight: 550;
  box-shadow: 0 1px 2px rgba(16, 24, 40, 0.16);
}
.dsm-pill[data-active='true'] .dsm-pill-dot { background: #fff; }
.dsm-pill-dot { width: 6px; height: 6px; border-radius: 99px; background: currentColor; opacity: 0.5; }
.dsm-pill--quiet { border-style: dashed; }

/* ── 输入 ───────────────────────────────────────────────────────────────── */
.dsm-input {
  width: 100%;
  height: 34px;
  padding: 0 12px;
  border: 1px solid var(--dsm-line);
  border-radius: var(--dsm-radius-sm);
  background: var(--dsm-surface);
  color: var(--dsm-text);
  font-size: 13px;
  outline: none;
  transition: border-color 140ms ease, box-shadow 140ms ease;
}
.dsm-input::placeholder { color: var(--dsm-text-2); opacity: 0.75; }
.dsm-input:focus {
  border-color: color-mix(in srgb, var(--dsm-accent) 60%, transparent);
  box-shadow: 0 0 0 3px color-mix(in srgb, var(--dsm-accent) 16%, transparent);
}
.dsm-input--sm { height: 30px; font-size: 12.5px; }
.dsm-search { position: relative; flex: 1 1 220px; min-width: 180px; }
.dsm-search .dsm-input { padding-left: 32px; }
.dsm-search-icon {
  position: absolute;
  left: 10px;
  top: 50%;
  transform: translateY(-50%);
  color: var(--dsm-text-2);
  pointer-events: none;
  display: grid;
  place-items: center;
}
.dsm-range { accent-color: var(--dsm-accent); height: 18px; cursor: pointer; }
.dsm-field { display: flex; flex-direction: column; gap: 5px; }
.dsm-field-label { font-size: 11.5px; color: var(--dsm-text-2); }
.dsm-form-grid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 12px; }

/* ── 卡片 ───────────────────────────────────────────────────────────────── */
.dsm-card {
  position: relative;
  padding: 14px 16px;
  border: 1px solid var(--dsm-line);
  border-radius: var(--dsm-radius-lg);
  background: var(--dsm-surface);
  box-shadow: var(--dsm-shadow-1);
  transition: box-shadow 160ms ease, border-color 160ms ease, transform 160ms ease;
}
.dsm-card:hover { box-shadow: var(--dsm-shadow-2); border-color: var(--dsm-line-strong); }
.dsm-card--flat { box-shadow: none; }
.dsm-card--accent { border-color: color-mix(in srgb, var(--dsm-accent) 34%, transparent); }
.dsm-card-head { display: flex; align-items: center; flex-wrap: wrap; gap: 8px; }
.dsm-card-title { font-size: 13px; font-weight: 600; }
.dsm-card-body {
  margin-top: 10px;
  font-size: 13.5px;
  line-height: 1.75;
  color: var(--dsm-text);
  white-space: pre-wrap;
  overflow-wrap: anywhere;
}
.dsm-card-foot {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 10px;
  margin-top: 12px;
  padding-top: 10px;
  border-top: 1px dashed var(--dsm-line);
  font-size: 11.5px;
  color: var(--dsm-text-2);
}

/* ── 标签 / 状态 ────────────────────────────────────────────────────────── */
.dsm-tag {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  padding: 2px 9px;
  border: 1px solid transparent;
  border-radius: 999px;
  background: var(--dsm-surface-2);
  color: var(--dsm-text-2);
  font-size: 11.5px;
  font-weight: 500;
  line-height: 1.6;
  white-space: nowrap;
}
.dsm-tag--accent { background: color-mix(in srgb, var(--dsm-accent) 13%, transparent); color: var(--dsm-accent); }
.dsm-tag--ok { background: color-mix(in srgb, var(--dsm-ok) 13%, transparent); color: var(--dsm-ok); }
.dsm-tag--warn { background: color-mix(in srgb, var(--dsm-warn) 15%, transparent); color: var(--dsm-warn); }
.dsm-tag--danger { background: color-mix(in srgb, var(--dsm-danger) 13%, transparent); color: var(--dsm-danger); }
.dsm-tag--idle { background: var(--dsm-surface-2); color: var(--dsm-text-2); }
.dsm-tag--outline { background: transparent; border-color: var(--dsm-line); }
.dsm-dot { width: 7px; height: 7px; border-radius: 99px; flex: 0 0 7px; background: var(--dsm-idle); }
.dsm-dot--ok { background: var(--dsm-ok); }
.dsm-dot--warn { background: var(--dsm-warn); }
.dsm-dot--danger { background: var(--dsm-danger); }
.dsm-dot--idle { background: var(--dsm-idle); }

/* ── 情感色签 ───────────────────────────────────────────────────────────── */
.dsm-emo {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  padding: 2px 10px;
  border: 1px solid transparent;
  border-radius: 999px;
  /* 先给不支持的浏览器一个中性底，再用 color-mix 叠一层 14% 的情感色——
     文字色已经是有色值，底色只是"淡淡地提醒一下是哪一类情绪"。 */
  background: var(--dsm-surface-2);
  background: color-mix(in srgb, var(--dsm-emo, var(--dsm-neutral)) 18%, transparent);
  border-color: color-mix(in srgb, var(--dsm-emo, var(--dsm-neutral)) 34%, transparent);
  color: var(--dsm-emo, var(--dsm-neutral));
  font-size: 11.5px;
  font-weight: 550;
  cursor: pointer;
  transition: filter 140ms ease, box-shadow 140ms ease;
}
.dsm-emo:hover { filter: brightness(0.97); box-shadow: 0 1px 2px rgba(16, 24, 40, 0.1); }
.dsm-emo::before {
  content: '';
  width: 6px;
  height: 6px;
  border-radius: 99px;
  background: currentColor;
  opacity: 0.9;
}
.dsm-emo--dashed { border-style: dashed; border-color: var(--dsm-line-strong); color: var(--dsm-text-2); }
.dsm-emo--joy { --dsm-emo: var(--dsm-joy); }
.dsm-emo--anxiety { --dsm-emo: var(--dsm-anxiety); }
.dsm-emo--frustration { --dsm-emo: var(--dsm-frustration); }
.dsm-emo--pride { --dsm-emo: var(--dsm-pride); }
.dsm-emo--curiosity { --dsm-emo: var(--dsm-curiosity); }
.dsm-emo--anger { --dsm-emo: var(--dsm-anger); }
.dsm-emo--sadness { --dsm-emo: var(--dsm-sadness); }
.dsm-emo--neutral { --dsm-emo: var(--dsm-neutral); }

/* ── 信任度 ─────────────────────────────────────────────────────────────── */
.dsm-trust { display: inline-flex; align-items: center; gap: 6px; }
.dsm-trust-track {
  width: 68px;
  height: 4px;
  border-radius: 99px;
  background: var(--dsm-surface-3);
  overflow: hidden;
}
.dsm-trust-fill {
  display: block;
  height: 100%;
  border-radius: 99px;
  background: var(--dsm-trust-tone, var(--dsm-accent));
  transition: width 220ms ease;
}
.dsm-trust[data-tone='ok'] { --dsm-trust-tone: var(--dsm-ok); }
.dsm-trust[data-tone='mid'] { --dsm-trust-tone: var(--dsm-accent); }
.dsm-trust[data-tone='low'] { --dsm-trust-tone: var(--dsm-warn); }

/* ── 横幅 / 空态 / 骨架 ─────────────────────────────────────────────────── */
.dsm-banner {
  display: flex;
  align-items: flex-start;
  gap: 10px;
  padding: 11px 18px;
  border-bottom: 1px solid var(--dsm-line);
  background: color-mix(in srgb, var(--dsm-warn) 10%, var(--dsm-surface));
  color: var(--dsm-warn);
  font-size: 12.5px;
}
.dsm-banner--danger { background: color-mix(in srgb, var(--dsm-danger) 10%, var(--dsm-surface)); color: var(--dsm-danger); }
.dsm-banner-title { font-weight: 600; }
.dsm-banner-hint { margin-top: 2px; color: var(--dsm-text-2); font-size: 11.5px; line-height: 1.65; }
.dsm-banner-detail { margin-top: 4px; font-family: var(--dsm-font-mono); font-size: 11px; color: var(--dsm-text-2); overflow-wrap: anywhere; }

.dsm-empty {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 7px;
  padding: 34px 20px;
  border: 1px dashed var(--dsm-line-strong);
  border-radius: var(--dsm-radius-lg);
  text-align: center;
  background: color-mix(in srgb, var(--dsm-surface) 60%, transparent);
}
.dsm-empty-icon { font-size: 22px; opacity: 0.4; }
.dsm-empty-title { font-size: 13px; font-weight: 600; }
.dsm-empty-hint { max-width: 380px; font-size: 12px; line-height: 1.7; color: var(--dsm-text-2); }

.dsm-skel {
  display: block;
  border-radius: 7px;
  background: linear-gradient(90deg, var(--dsm-surface-2) 25%, var(--dsm-surface-3) 37%, var(--dsm-surface-2) 63%);
  background-size: 400% 100%;
  animation: dsm-shimmer 1.5s ease infinite;
}
.dsm-skel-card {
  display: flex;
  flex-direction: column;
  gap: 8px;
  padding: 14px 16px;
  border: 1px solid var(--dsm-line);
  border-radius: var(--dsm-radius-lg);
  background: var(--dsm-surface);
}

/* ── 顶部统计 ───────────────────────────────────────────────────────────── */
.dsm-stats { display: flex; flex-wrap: wrap; gap: 8px; }
.dsm-stat {
  display: flex;
  flex-direction: column;
  gap: 1px;
  min-width: 74px;
  padding: 8px 12px;
  border: 1px solid var(--dsm-line);
  border-radius: var(--dsm-radius);
  background: var(--dsm-surface);
}
.dsm-stat-value { font-size: 15px; font-weight: 650; font-variant-numeric: tabular-nums; }
.dsm-stat-label { font-size: 11px; color: var(--dsm-text-2); }

/* ── 时间轴 ─────────────────────────────────────────────────────────────── */
.dsm-timeline { position: relative; padding-left: 24px; }
.dsm-timeline::before {
  content: '';
  position: absolute;
  left: 5px;
  top: 8px;
  bottom: 10px;
  width: 2px;
  border-radius: 99px;
  background: linear-gradient(to bottom, var(--dsm-line-strong), var(--dsm-line) 72%, transparent);
}
.dsm-node { position: relative; margin-bottom: 12px; }
.dsm-node:last-child { margin-bottom: 0; }
.dsm-node::before {
  content: '';
  position: absolute;
  left: -24px;
  top: 17px;
  width: 10px;
  height: 10px;
  border-radius: 99px;
  background: var(--dsm-node-color, var(--dsm-idle));
  box-shadow: 0 0 0 3px var(--dsm-bg);
  transition: transform 140ms ease;
}
.dsm-node[data-latest='true']::before { transform: scale(1.25); }
.dsm-node[data-pinned='true']::before {
  box-shadow: 0 0 0 3px var(--dsm-bg), 0 0 0 4.5px color-mix(in srgb, var(--dsm-node-color, var(--dsm-accent)) 35%, transparent);
}
.dsm-node-card { padding: 12px 14px; }
.dsm-node-meta { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; font-size: 11.5px; color: var(--dsm-text-2); }
.dsm-node-summary { margin-top: 6px; font-size: 12.5px; line-height: 1.65; color: var(--dsm-text); }
.dsm-legend { display: flex; flex-wrap: wrap; gap: 10px; font-size: 11.5px; color: var(--dsm-text-2); }
.dsm-legend-item { display: inline-flex; align-items: center; gap: 5px; }
.dsm-legend-swatch { width: 7px; height: 7px; border-radius: 99px; background: var(--dsm-swatch, var(--dsm-idle)); }

/* ── 弹层 ───────────────────────────────────────────────────────────────── */
.dsm-modal-mask {
  position: fixed;
  inset: 0;
  z-index: 70;
  display: grid;
  place-items: center;
  padding: 16px;
  background: rgba(9, 13, 24, 0.42);
  backdrop-filter: blur(3px);
  animation: dsm-fade 140ms ease-out;
}
.dsm-modal {
  width: min(460px, 100%);
  max-height: 86vh;
  overflow: auto;
  padding: 18px;
  border: 1px solid var(--dsm-line);
  border-radius: var(--dsm-radius-lg);
  background: var(--dsm-overlay);
  box-shadow: var(--dsm-shadow-pop);
  animation: dsm-pop 170ms cubic-bezier(0.2, 0.9, 0.3, 1);
}
.dsm-modal-head { display: flex; align-items: center; gap: 8px; }
.dsm-modal-title { font-size: 14.5px; font-weight: 620; }
.dsm-modal-body { margin-top: 8px; font-size: 12.5px; line-height: 1.7; color: var(--dsm-text-2); }
.dsm-modal-actions { display: flex; justify-content: flex-end; gap: 8px; margin-top: 16px; }
.dsm-quote {
  margin-top: 10px;
  padding: 8px 10px;
  border-radius: var(--dsm-radius-sm);
  background: var(--dsm-surface-2);
  font-size: 12.5px;
  color: var(--dsm-text);
  display: -webkit-box;
  -webkit-line-clamp: 3;
  -webkit-box-orient: vertical;
  overflow: hidden;
}

/* ── 下拉菜单 ───────────────────────────────────────────────────────────── */
.dsm-menu-wrap { position: relative; }
.dsm-agent-btn {
  display: inline-flex;
  align-items: center;
  gap: 8px;
  height: 34px;
  padding: 0 10px 0 6px;
  border: 1px solid var(--dsm-line);
  border-radius: 999px;
  background: var(--dsm-surface);
  color: var(--dsm-text);
  font-size: 12.5px;
  cursor: pointer;
  transition: border-color 140ms ease, box-shadow 140ms ease;
}
.dsm-agent-btn:hover { border-color: var(--dsm-line-strong); box-shadow: var(--dsm-shadow-1); }
.dsm-avatar {
  display: grid;
  place-items: center;
  width: 24px;
  height: 24px;
  border-radius: 99px;
  background: color-mix(in srgb, var(--dsm-accent) 16%, transparent);
  color: var(--dsm-accent);
  font-size: 11px;
  font-weight: 650;
}
.dsm-caret { color: var(--dsm-text-2); font-size: 10px; }
/* 菜单浮在 header 的层叠上下文里，z-index 要比 header 里的其它元素高，
   同时给宽度/高度上限：贴到窗口边缘时不会溢出，条目多了自己滚。 */
.dsm-menu {
  position: absolute;
  top: calc(100% + 6px);
  left: 0;
  z-index: 90;
  width: max-content;
  min-width: 200px;
  max-width: min(300px, calc(100vw - 24px));
  max-height: min(60vh, 340px);
  overflow: auto;
  padding: 6px;
  border: 1px solid var(--dsm-line);
  border-radius: var(--dsm-radius);
  background: var(--dsm-overlay);
  box-shadow: var(--dsm-shadow-pop);
  animation: dsm-pop 150ms ease-out;
}
/* 触发按钮靠右时用这个，菜单改成向左展开，避免顶出右边界。 */
.dsm-menu--right { left: auto; right: 0; }

/* Portal 版本：菜单挂在 <body> 上，用 position: fixed + 计算出的坐标定位。
   为什么不继续用绝对定位：header 有 backdrop-filter，任何祖先只要带
   overflow/transform/filter 就会把绝对定位的子元素裁在层叠上下文里。
   挂到 body 之后，祖先的 clip 与 stacking context 全部不再参与，只剩一个
   全局 z-index 需要自己管好。 */
.dsm-menu--portal {
  position: fixed;
  top: 0;
  left: 0;
  z-index: 1000;
  width: max-content;
  min-width: 220px;
  max-width: min(320px, calc(100vw - 24px));
  max-height: min(60vh, 360px);
  overflow: auto;
  /* 挂到 body 之后不再继承 .dsm-root 的字体/行高，这里显式接回来。 */
  font-family: inherit;
  font-size: 13px;
  line-height: 1.45;
  color: var(--dsm-text);
  text-align: left;
}
.dsm-menu-item {
  display: flex;
  align-items: center;
  gap: 10px;
  width: 100%;
  padding: 7px 10px;
  border: 0;
  border-radius: 8px;
  background: transparent;
  color: var(--dsm-text);
  font-size: 12.5px;
  text-align: left;
  cursor: pointer;
}
.dsm-menu-item:hover { background: var(--dsm-surface-2); }
.dsm-menu-item[data-active='true'] { color: var(--dsm-accent); font-weight: 600; }
.dsm-menu-name { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.dsm-menu-meta { margin-left: auto; font-size: 11px; color: var(--dsm-text-2); white-space: nowrap; }
.dsm-menu-empty { padding: 10px; font-size: 12px; color: var(--dsm-text-2); }

/* ── Toast ──────────────────────────────────────────────────────────────── */
.dsm-toast {
  position: fixed;
  left: 50%;
  bottom: 24px;
  transform: translateX(-50%);
  z-index: 80;
  max-width: min(560px, calc(100vw - 32px));
  padding: 9px 16px;
  border-radius: 999px;
  font-size: 12.5px;
  font-weight: 500;
  color: #fff;
  background: var(--dsm-ok);
  box-shadow: 0 14px 34px -14px rgba(9, 13, 24, 0.55);
  animation: dsm-rise 180ms ease-out;
}
.dsm-toast--error { background: var(--dsm-danger); }
.dsm-toast--warn { background: var(--dsm-warn); }

/* ── 代码 / 预览 ────────────────────────────────────────────────────────── */
.dsm-code {
  padding: 2px 6px;
  border-radius: 6px;
  background: var(--dsm-surface-2);
  font-family: var(--dsm-font-mono);
  font-size: 11.5px;
}
.dsm-pre {
  margin: 0;
  padding: 12px 14px;
  border: 1px solid var(--dsm-line);
  border-radius: var(--dsm-radius);
  background: var(--dsm-surface-2);
  font-family: var(--dsm-font-mono);
  font-size: 11.5px;
  line-height: 1.7;
  color: var(--dsm-text-2);
  white-space: pre-wrap;
  overflow-wrap: anywhere;
}
.dsm-split { display: grid; grid-template-columns: minmax(0, 1fr) minmax(0, 1fr); gap: 14px; align-items: start; }
.dsm-scroll-y { max-height: 420px; overflow: auto; }

/* ── 进度 / 分数条 ──────────────────────────────────────────────────────── */
.dsm-progress {
  position: relative;
  height: 5px;
  border-radius: 99px;
  background: var(--dsm-surface-3);
  overflow: hidden;
}
.dsm-progress > i {
  display: block;
  height: 100%;
  border-radius: 99px;
  background: var(--dsm-progress-tone, var(--dsm-danger));
}

/* ── 加载态 ─────────────────────────────────────────────────────────────── */
.dsm-loading { display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 12px; min-height: 460px; }
.dsm-spinner {
  width: 26px;
  height: 26px;
  border-radius: 99px;
  border: 2px solid var(--dsm-line-strong);
  border-top-color: var(--dsm-accent);
  animation: dsm-spin 760ms linear infinite;
}
.dsm-loading-text { font-size: 12.5px; color: var(--dsm-text); }
.dsm-loading-detail { font-size: 11.5px; color: var(--dsm-text-2); max-width: 420px; text-align: center; overflow-wrap: anywhere; }

/* ── 响应式 ─────────────────────────────────────────────────────────────── */
.dsm-nav-inline { display: none; }
@media (max-width: 720px) {
  .dsm-sidebar { display: none; }
  .dsm-nav-inline {
    display: flex;
    gap: 6px;
    overflow-x: auto;
    padding: 0 18px 10px;
    border-bottom: 1px solid var(--dsm-line);
  }
  .dsm-page { padding-bottom: 12px; }
  .dsm-split { grid-template-columns: minmax(0, 1fr); }
  .dsm-form-grid { grid-template-columns: minmax(0, 1fr); }
  .dsm-content { padding: 14px 14px 26px; }
}

/* ── 会话工具条：深度重读 + 提炼进度 ──────────────────────────────────── */
.dsm-session-bar {
  display: flex;
  flex-direction: column;
  gap: 8px;
  padding: 10px 14px;
  border: 1px solid var(--dsm-line);
  border-radius: var(--dsm-radius);
  background: var(--dsm-surface);
  transition: background 160ms ease, border-color 160ms ease;
}
/* 无痕开关**已经从这里删掉**：它是新建会话时的二选一（session-menu.tsx），
   事后再补一个开关既误导人（以为已经无痕），又会放过开聊前的几句话。
   这条工具条只剩"深度重读"和它的进度。 */
.dsm-session-progress {
  display: flex;
  align-items: center;
  gap: 10px;
}
.dsm-progress[data-tone='running'] > i { background: var(--dsm-accent); }
.dsm-progress[data-tone='done'] > i { background: var(--dsm-ok); }
.dsm-progress[data-tone='failed'] > i { background: var(--dsm-danger); }
.dsm-progress[data-tone='skipped'] > i { background: var(--dsm-text-2); }
.dsm-progress[data-tone='timeout'] > i { background: var(--dsm-warn); }
.dsm-check {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 12.5px;
  color: var(--dsm-text-2);
}
.dsm-check input { accent-color: var(--dsm-danger); }
.dsm-danger-title { color: var(--dsm-danger); }
.dsm-danger-list {
  display: flex;
  flex-direction: column;
  gap: 4px;
  margin: 0;
  padding-left: 18px;
  font-size: 12px;
  line-height: 1.65;
  color: var(--dsm-text-2);
}

/* ── 新建会话：正常 / 无痕 二选一 ───────────────────────────────────────── */
.dsm-choice {
  display: grid;
  grid-template-columns: minmax(0, 1fr) minmax(0, 1fr);
  gap: 12px;
}
@media (max-width: 560px) {
  .dsm-choice { grid-template-columns: minmax(0, 1fr); }
}
/* 卡片本身就是按钮：原生 button，键盘 Tab / Enter 直接可用，不额外做 tabindex。 */
.dsm-choice-card {
  display: flex;
  flex-direction: column;
  gap: 6px;
  padding: 16px 16px 14px;
  border: 1px solid var(--dsm-line);
  border-radius: var(--dsm-radius);
  background: var(--dsm-surface-2);
  color: var(--dsm-text);
  font: inherit;
  text-align: left;
  cursor: pointer;
  transition: border-color 140ms ease, background 140ms ease, transform 140ms ease;
}
.dsm-choice-card:hover {
  border-color: var(--dsm-accent);
  transform: translateY(-1px);
}
.dsm-choice-card:focus-visible {
  outline: 2px solid var(--dsm-accent);
  outline-offset: 2px;
}
/* 无痕用暖色：这是"内容不进库"的承诺，视觉上必须和正常会话区分开。 */
.dsm-choice-card--ghost {
  background: color-mix(in srgb, var(--dsm-warn) 7%, var(--dsm-surface));
  border-color: color-mix(in srgb, var(--dsm-warn) 30%, transparent);
}
.dsm-choice-card--ghost:hover { border-color: var(--dsm-warn); }
.dsm-choice-icon { font-size: 20px; line-height: 1; }
.dsm-choice-title { font-size: 13.5px; font-weight: 600; }
.dsm-choice-body { font-size: 12px; line-height: 1.65; color: var(--dsm-text-2); }
.dsm-choice-foot {
  margin-top: auto;
  padding-top: 6px;
  font-size: 11px;
  color: var(--dsm-text-2);
  opacity: 0.85;
}

/* ── 会话行「⋯」菜单项 ─────────────────────────────────────────────────── */
/* 这三项渲染在宿主自己的 Menu 里，所以不自带外框，只做一个 hover 态的行。 */
.dsm-menu-row {
  display: flex;
  align-items: center;
  gap: 8px;
  width: 100%;
  padding: 7px 10px;
  border: 0;
  border-radius: 8px;
  background: transparent;
  color: var(--dsm-text);
  font: inherit;
  font-size: 12.5px;
  text-align: left;
  cursor: pointer;
}
.dsm-menu-row:hover:not(:disabled) { background: var(--dsm-surface-2); }
.dsm-menu-row:disabled { opacity: 0.55; cursor: default; }
.dsm-menu-row--danger { color: var(--dsm-danger); }
.dsm-menu-row--danger:hover:not(:disabled) {
  background: color-mix(in srgb, var(--dsm-danger) 10%, transparent);
}
.dsm-menu-icon { flex: 0 0 16px; text-align: center; }
.dsm-menu-label {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.dsm-menu-text {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
}
.dsm-menu-hint {
  font-size: 11px;
  color: var(--dsm-muted);
  line-height: 1.3;
  white-space: normal;
}

/* ── 全局 toast（挂在 shell.overlay，面板没开也看得见） ─────────────────── */
.dsm-toast-stack {
  position: fixed;
  top: 16px;
  right: 16px;
  z-index: 90;
  display: flex;
  flex-direction: column;
  align-items: flex-end;
  gap: 8px;
  pointer-events: none;
}
/* 覆盖面板内联 Toast 的居中 fixed 定位：在栈里它是普通流内元素。 */
.dsm-toast-stack .dsm-toast {
  position: static;
  left: auto;
  bottom: auto;
  transform: none;
  display: flex;
  align-items: center;
  gap: 8px;
  max-width: min(420px, calc(100vw - 40px));
  padding: 9px 13px;
  border-radius: var(--dsm-radius-sm);
  box-shadow: var(--dsm-shadow-pop);
  animation: dsm-pop 160ms ease-out;
  pointer-events: auto;
}
.dsm-toast-stack .dsm-toast[data-tone='ok'] { background: var(--dsm-ok); }
.dsm-toast-stack .dsm-toast[data-tone='warn'] { background: var(--dsm-warn); }
.dsm-toast-stack .dsm-toast[data-tone='error'] { background: var(--dsm-danger); }
.dsm-toast-dot {
  flex: 0 0 auto;
  width: 6px;
  height: 6px;
  border-radius: 99px;
  background: currentColor;
  opacity: 0.7;
}

/* ── 提炼进度浮动卡（右下角；toast 走右上，两者不会互压） ───────────────── */
.dsm-float-card {
  position: fixed;
  right: 20px;
  bottom: 20px;
  z-index: 85;
  display: flex;
  flex-direction: column;
  gap: 8px;
  width: min(320px, calc(100vw - 40px));
  padding: 12px 14px;
  border: 1px solid var(--dsm-line);
  border-radius: var(--dsm-radius);
  background: var(--dsm-overlay);
  box-shadow: var(--dsm-shadow-pop);
  animation: dsm-pop 180ms ease-out;
}
.dsm-float-title { font-size: 12.5px; font-weight: 600; }

/* ── 无痕会话的持久视觉标识 ─────────────────────────────────────────────── */
/* 聊天头部徽标：挂在 conversation.session.header.actions 里，随会话切换自动显隐。 */
.dsm-ghost-badge {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  height: 24px;
  padding: 0 10px;
  border: 1px solid color-mix(in oklab, var(--dsm-warn) 55%, transparent);
  border-radius: 999px;
  background: color-mix(in oklab, var(--dsm-warn) 14%, transparent);
  color: var(--dsm-warn);
  font-size: 12px;
  font-weight: 600;
  letter-spacing: 0.2px;
  white-space: nowrap;
  user-select: none;
}
.dsm-ghost-badge-dot { font-size: 12.5px; line-height: 1; filter: saturate(0.85); }

/* 侧栏会话行的小幽灵：只占一个图标位，不抢标题宽度。 */
.dsm-ghost-row {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 16px;
  height: 16px;
  font-size: 11px;
  line-height: 1;
  opacity: 0.75;
  flex: none;
  user-select: none;
}

/*
 * 整窗警戒：由数据源直接给 <html> 打 data-dsm-ephemeral（不再依赖组件挂载）。
 * fixed 覆盖层画内描边 + 顶部暖色渐隐，pointer-events:none 保证点得到下面的一切。
 */
html[data-dsm-ephemeral='1'] body::before {
  content: '';
  position: fixed;
  inset: 0;
  z-index: 900;
  pointer-events: none;
  box-shadow:
    inset 0 0 0 3px color-mix(in oklab, var(--dsm-warn) 62%, transparent),
    inset 0 22px 44px -20px color-mix(in oklab, var(--dsm-warn) 70%, transparent);
  background: linear-gradient(
    180deg,
    color-mix(in oklab, var(--dsm-warn) 12%, transparent) 0,
    transparent 220px
  );
}

/*
 * 主线：顶部常驻警告带（挂 shell.overlay）。
 * 之所以敢用 fixed + 高 z-index：它和 Toast 是同一个浮层容器，真机已验证可渲染；
 * pointer-events:none 让它只是"看得见"，绝不挡住下面的任何点击。
 */
.dsm-ghost-banner {
  position: fixed;
  top: calc(var(--dsh-windows-titlebar-height, 0px) + 10px);
  left: 50%;
  transform: translateX(-50%);
  z-index: 950;
  display: inline-flex;
  align-items: center;
  gap: 8px;
  max-width: calc(100vw - 32px);
  padding: 7px 16px;
  border: 1px solid color-mix(in oklab, var(--dsm-warn) 62%, #5c2f00);
  border-radius: 999px;
  background: color-mix(in oklab, var(--dsm-warn) 90%, #4a2600);
  color: #fff8e8;
  font-size: 12.5px;
  font-weight: 600;
  letter-spacing: 0.2px;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  pointer-events: none;
  user-select: none;
  box-shadow:
    0 10px 26px -10px rgba(96, 48, 0, 0.6),
    0 0 0 4px color-mix(in oklab, var(--dsm-warn) 16%, transparent);
  animation: dsm-fade 160ms ease-out;
}
.dsm-ghost-banner-icon { font-size: 13px; line-height: 1; filter: saturate(0.9); }
.dsm-ghost-banner-text { overflow: hidden; text-overflow: ellipsis; }

@media (max-width: 720px) {
  .dsm-ghost-banner { font-size: 11.5px; padding: 6px 12px; }
}

/* ── 动画 ───────────────────────────────────────────────────────────────── */
@keyframes dsm-shimmer { 0% { background-position: 100% 50%; } 100% { background-position: 0 50%; } }
@keyframes dsm-spin { to { transform: rotate(360deg); } }
@keyframes dsm-rise { from { opacity: 0; transform: translate(-50%, 8px); } to { opacity: 1; transform: translate(-50%, 0); } }
@keyframes dsm-pop { from { opacity: 0; transform: translateY(6px) scale(0.985); } to { opacity: 1; transform: none; } }
@keyframes dsm-fade { from { opacity: 0; } to { opacity: 1; } }

@media (prefers-reduced-motion: reduce) {
  .dsm-root *,
  .dsm-root *::before,
  .dsm-root *::after {
    animation-duration: 0.001ms !important;
    animation-iteration-count: 1 !important;
    transition-duration: 0.001ms !important;
  }
}
`

/**
 * 注入样式表。幂等：同一个 `document` 里只会有一个 `<style>`，
 * 面板被宿主反复挂载/卸载也不会堆出一串重复样式。
 */
export function installConsoleStyles(target?: Document): void {
  const doc = target ?? (typeof document === 'undefined' ? undefined : document)
  if (!doc || !doc.head) return
  if (doc.getElementById(CONSOLE_STYLE_ID)) return
  const style = doc.createElement('style')
  style.id = CONSOLE_STYLE_ID
  style.textContent = CONSOLE_CSS
  doc.head.append(style)
}
