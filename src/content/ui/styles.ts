/** 面板样式 —— 注入 Shadow DOM，与宿主页样式完全隔离 */

export const STYLES = `
:host {
  all: initial;

  --brand: #FF2442;
  --brand-text: #D81E38;
  --brand-press: #E01F3D;
  --brand-grad: linear-gradient(135deg, #FF5C72 0%, #FF2442 100%);
  --brand-soft: rgba(255, 36, 66, .10);

  --bg-canvas: #FFFFFF;
  --bg-raised: #F7F7F9;
  --bg-sunken: #F0F0F3;
  --bg-hover: #F2F2F5;
  --bg-active: #ECECF0;
  --border: #E9E9EE;
  --border-strong: #D8D8E0;

  --text-1: #18181C;
  --text-2: #5E5E69;
  --text-3: #9494A0;

  --success: #0F9D58;
  --success-bg: #ECFDF3;
  --warning: #B7791F;
  --warning-bg: #FFFAEB;
  --danger: #D92D20;
  --danger-bg: #FEF3F2;

  --sh-fab: 0 6px 16px rgba(255,36,66,.30), 0 2px 4px rgba(20,20,30,.12);
  --sh-panel: 0 16px 48px rgba(20,20,35,.18), 0 4px 12px rgba(20,20,35,.10);
  --sh-card: 0 2px 8px rgba(20,20,35,.08);
  --sh-card-hov: 0 6px 16px rgba(20,20,35,.14);
  --sh-pop: 0 8px 24px rgba(20,20,35,.16);
  --sh-toast: 0 8px 28px rgba(20,20,35,.20);

  --focus-ring: rgba(255,36,66,.30);

  --r-xs: 4px; --r-sm: 6px; --r-md: 8px; --r-lg: 12px; --r-xl: 16px;

  --font: -apple-system, BlinkMacSystemFont, "SF Pro SC", "PingFang SC",
    "Hiragino Sans GB", "Microsoft YaHei", "Helvetica Neue", Helvetica, Arial, sans-serif;
}

:host([data-theme="dark"]) {
  --brand: #FF4D62;
  --brand-text: #FF7A8C;
  --brand-press: #FF5C6E;
  --brand-grad: linear-gradient(135deg, #FF6B7E 0%, #FF3B52 100%);
  --brand-soft: rgba(255,77,98,.16);
  --bg-canvas: #1B1B1F;
  --bg-raised: #242429;
  --bg-sunken: #2C2C33;
  --bg-hover: #2A2A30;
  --bg-active: #32323A;
  --border: #34343C;
  --border-strong: #45454F;
  --text-1: #F0F0F4;
  --text-2: #A2A2AE;
  --text-3: #6E6E7A;
  --success: #32D583;
  --success-bg: #14261D;
  --warning: #FDB022;
  --warning-bg: #2E2413;
  --danger: #F97066;
  --danger-bg: #2A1A1C;
  --sh-fab: 0 6px 16px rgba(0,0,0,.45);
  --sh-panel: 0 16px 48px rgba(0,0,0,.55), 0 4px 12px rgba(0,0,0,.4);
  --sh-card: 0 2px 8px rgba(0,0,0,.35);
  --sh-card-hov: 0 6px 16px rgba(0,0,0,.5);
  --sh-pop: 0 8px 24px rgba(0,0,0,.5);
  --sh-toast: 0 8px 28px rgba(0,0,0,.55);
  --focus-ring: rgba(255,77,98,.38);
}

* { box-sizing: border-box; margin: 0; padding: 0; }

.rn-root {
  position: fixed;
  inset: 0;
  z-index: 2147483000;
  pointer-events: none;
  font-family: var(--font);
  color: var(--text-1);
  font-size: 13px;
  line-height: 1.5;
  -webkit-font-smoothing: antialiased;
  font-variant-numeric: tabular-nums;
}

button { font-family: inherit; }
:focus-visible { outline: 2px solid var(--brand); outline-offset: 2px; border-radius: var(--r-sm); }

/* ============ 悬浮入口 FAB ============ */

.rn-fab {
  position: fixed;
  pointer-events: auto;
  height: 48px; min-width: 48px;
  padding: 0 14px;
  border: none; border-radius: 24px;
  cursor: pointer;
  background: var(--brand-grad);
  color: #fff;
  box-shadow: var(--sh-fab);
  display: inline-flex; align-items: center; gap: 0;
  overflow: hidden;
  transition: transform .22s cubic-bezier(.2,.8,.3,1), opacity .18s ease, gap .22s ease, padding .22s ease;
}
.rn-fab:hover { transform: translateY(-1px) scale(1.03); }
.rn-fab:active { transform: scale(.96); }
.rn-fab svg { width: 22px; height: 22px; flex: none; }
.rn-fab[data-variant="ghost"] { background: var(--bg-canvas); color: var(--text-3); box-shadow: var(--sh-card); }
.rn-fab-label {
  max-width: 0; opacity: 0; white-space: nowrap;
  font-size: 13px; font-weight: 600; letter-spacing: .01em;
  transition: max-width .24s cubic-bezier(.16,1,.3,1), opacity .16s ease;
}
.rn-fab:hover .rn-fab-label,
.rn-fab:focus-visible .rn-fab-label { max-width: 64px; opacity: 1; margin-left: 8px; }
.rn-fab-badge {
  position: absolute; top: -3px; right: -3px;
  min-width: 19px; height: 19px; padding: 0 5px;
  border-radius: 10px;
  background: var(--text-1); color: var(--bg-canvas);
  font-size: 11px; font-weight: 700; line-height: 19px; text-align: center;
  box-shadow: 0 0 0 2px var(--bg-canvas);
  transition: transform .2s cubic-bezier(.16,1,.3,1);
}
.rn-fab[data-badge="0"] .rn-fab-badge { display: none; }
.rn-fab-progress {
  position: absolute; inset: -4px;
  pointer-events: none;
}
.rn-fab-progress circle { fill: none; stroke: var(--brand); stroke-width: 3; stroke-linecap: round; transform: rotate(-90deg); transform-origin: center; }
.rn-fab-progress .track { stroke: transparent; }
.rn-fab[data-mode="bg"] { height: 40px; min-width: 40px; padding: 0 9px; }

/* ============ 面板 ============ */

.rn-panel {
  position: fixed;
  pointer-events: auto;
  display: flex; flex-direction: column;
  background: var(--bg-canvas);
  border: 1px solid var(--border);
  border-radius: var(--r-xl);
  box-shadow: var(--sh-panel);
  overflow: hidden;
  opacity: 0;
  transform: translateY(8px) scale(.97);
  pointer-events: none;
  transition: opacity .2s cubic-bezier(.16,1,.3,1), transform .2s cubic-bezier(.16,1,.3,1);
}
.rn-panel[data-open="true"] { opacity: 1; transform: none; pointer-events: auto; }
.rn-panel[data-mode="note"] { width: 360px; max-width: calc(100vw - 32px); max-height: min(620px, 68vh); }
.rn-panel[data-mode="batch"] { width: 480px; max-width: calc(100vw - 32px); top: 76px; bottom: 24px; }
.rn-panel[data-mode="drawer"] {
  width: auto; left: 16px; right: 16px; bottom: 0;
  top: auto; max-height: 78vh;
  border-radius: var(--r-xl) var(--r-xl) 0 0;
  transform: translateY(20px);
}
.rn-panel[data-mode="drawer"][data-open="true"] { transform: none; }
.rn-panel[data-mode="full"] { width: auto; left: 0; right: 0; top: 56px; bottom: 0; max-width: none; border-radius: 0; border-left: none; border-right: none; }

.rn-grabber { display: none; }
.rn-panel[data-mode="drawer"] .rn-grabber {
  display: block; width: 36px; height: 4px; border-radius: 2px;
  background: var(--border-strong); margin: 8px auto 0; flex: none;
}

/* ============ 头部 ============ */

.rn-header {
  flex: none;
  display: flex; align-items: flex-start; gap: 10px;
  padding: 14px 12px 12px 16px;
  border-bottom: 1px solid var(--border);
}
.rn-avatar {
  width: 32px; height: 32px; flex: none; border-radius: 50%;
  object-fit: cover; background: var(--bg-raised);
  display: grid; place-items: center; color: var(--text-3); overflow: hidden;
}
.rn-avatar img { width: 100%; height: 100%; object-fit: cover; }
.rn-head-text { flex: 1; min-width: 0; }
.rn-head-title {
  font-size: 15px; font-weight: 600; line-height: 22px;
  white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
}
.rn-head-sub { font-size: 12px; line-height: 16px; color: var(--text-2); margin-top: 2px; }
.rn-head-actions { display: flex; gap: 2px; flex: none; }

.rn-icon-btn {
  width: 30px; height: 30px;
  border: none; border-radius: var(--r-md);
  background: transparent; color: var(--text-2);
  cursor: pointer; display: grid; place-items: center;
  transition: background .12s ease, color .12s ease;
}
.rn-icon-btn:hover { background: var(--bg-hover); color: var(--text-1); }

/* ============ 内容区 ============ */

.rn-body { flex: 1; overflow-y: auto; overscroll-behavior: contain; min-height: 0; }
.rn-body::-webkit-scrollbar { width: 8px; }
.rn-body::-webkit-scrollbar-thumb { background: var(--border-strong); border-radius: 4px; border: 2px solid var(--bg-canvas); }
.rn-body::-webkit-scrollbar-track { background: transparent; }

.rn-section { padding: 14px 16px 4px; }
.rn-section + .rn-section { border-top: 1px solid var(--border); }

.rn-section-head {
  width: 100%;
  display: flex; align-items: center; gap: 7px;
  padding: 0; margin: 0 0 8px;
  background: none; border: none; cursor: pointer;
  font-size: 13px; font-weight: 600; line-height: 18px;
  color: var(--text-1);
  text-align: left;
}
.rn-section-head:hover { color: var(--brand-text); }
.rn-section-head .rn-caret { transition: transform .16s ease; color: var(--text-3); }
.rn-section-head[aria-expanded="false"] .rn-caret { transform: rotate(-90deg); }
.rn-section-head .rn-count {
  margin-left: auto; font-weight: 500; font-size: 11px; color: var(--text-3);
}
.rn-group-toggle {
  display: inline-flex; align-items: center; gap: 5px;
  font-size: 11.5px; font-weight: 500; color: var(--text-2);
  background: none; border: none; cursor: pointer; padding: 2px 6px;
  border-radius: var(--r-sm);
}
.rn-group-toggle:hover { background: var(--bg-hover); color: var(--text-1); }
.rn-group-toggle input { accent-color: var(--brand); width: 14px; height: 14px; margin: 0; cursor: pointer; }
.rn-count-pill {
  font-size: 11px; font-weight: 500; color: var(--text-2);
  background: var(--bg-raised); padding: 2px 8px; border-radius: 12px;
}

/* ============ 资源行（单篇） ============ */

.rn-row {
  display: flex; align-items: center; gap: 10px;
  padding: 7px; margin-bottom: 6px;
  border-radius: var(--r-md);
  border: 1px solid transparent;
  transition: background .12s ease, border-color .12s ease;
}
.rn-row:hover { background: var(--bg-hover); }
.rn-row[data-state="downloading"] { background: var(--brand-soft); border-color: rgba(255,36,66,.16); }
.rn-row[data-state="retrying"] { background: var(--warning-bg, var(--brand-soft)); border-color: rgba(255,149,0,.2); }
.rn-row[data-state="completed"] { background: var(--success-bg); }
.rn-row[data-state="failed"] { background: var(--danger-bg); }
.rn-row-meta .rn-retrying { color: var(--warning); font-weight: 500; }

.rn-thumb {
  width: 40px; height: 40px; flex: none;
  border-radius: var(--r-sm); overflow: hidden;
  background: var(--bg-raised); position: relative;
  display: grid; place-items: center; color: var(--text-3);
}
.rn-thumb img { width: 100%; height: 100%; object-fit: cover; display: block; }
.rn-thumb .rn-thumb-play {
  position: absolute; inset: 0; display: grid; place-items: center;
  background: rgba(0,0,0,.32); color: #fff;
}
.rn-thumb .rn-thumb-play svg { width: 14px; height: 14px; }
.rn-thumb .rn-thumb-done {
  position: absolute; top: 2px; right: 2px;
  width: 15px; height: 15px; border-radius: 50%;
  background: var(--success); color: #fff;
  display: grid; place-items: center;
  box-shadow: 0 0 0 1.5px var(--bg-canvas);
}
.rn-thumb .rn-thumb-done svg { width: 9px; height: 9px; }

.rn-row-main { flex: 1; min-width: 0; }
.rn-row-name {
  font-size: 13px; font-weight: 500; line-height: 18px;
  white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
}
.rn-row-meta {
  font-size: 12px; line-height: 16px; color: var(--text-2); margin-top: 1px;
  white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
}
.rn-row-meta .rn-err { color: var(--danger); }
.rn-row-bar { margin-top: 5px; height: 4px; border-radius: 3px; background: var(--bg-sunken); overflow: hidden; }
.rn-row-bar > i { display: block; height: 100%; width: 0; background: var(--brand); transition: width .2s linear; }
.rn-row-pct { font-size: 12px; font-weight: 600; color: var(--brand-text); flex: none; min-width: 34px; text-align: right; }
/* 右侧操作区的外壳：display:contents 让里面的按钮仍然直接参与 flex 布局，
   这样进度更新时可以只换操作区的内容，不必重建整行 */
.rn-row-action { display: contents; }

/* ============ 按钮 ============ */

.rn-btn {
  height: 30px; padding: 0 11px;
  border-radius: var(--r-md); border: 1px solid var(--border);
  background: var(--bg-raised); color: var(--text-1);
  font-size: 13px; font-weight: 500;
  cursor: pointer;
  display: inline-flex; align-items: center; gap: 5px;
  transition: background .12s ease, border-color .12s ease, color .12s ease, transform .1s ease;
  white-space: nowrap;
}
.rn-btn:hover { border-color: var(--brand); color: var(--brand-text); }
.rn-btn:active { transform: translateY(1px); }
.rn-btn svg { width: 15px; height: 15px; }
.rn-btn[disabled] { opacity: .45; cursor: not-allowed; }
.rn-btn[disabled]:hover { border-color: var(--border); color: var(--text-1); }
.rn-btn[data-variant="primary"] { background: var(--brand-press); border-color: var(--brand-press); color: #fff; }
.rn-btn[data-variant="primary"]:hover { background: var(--brand); border-color: var(--brand); color: #fff; }
.rn-btn[data-variant="text"] {
  background: none; border-color: transparent; color: var(--text-2); height: 28px; padding: 0 6px;
}
.rn-btn[data-variant="text"]:hover { background: var(--bg-hover); color: var(--text-1); border-color: transparent; }
.rn-btn[data-variant="sm"] { height: 26px; padding: 0 8px; font-size: 12px; border-radius: var(--r-sm); }

/* ============ 工具条（批量） ============ */

/* hidden 属性必须能盖住 display:flex，否则会留下一条空白条 */
[hidden] { display: none !important; }

.rn-toolbar {
  flex: none;
  display: flex;
  flex-direction: column;
  align-items: stretch;
  gap: 8px;
  padding: 8px 16px;
  border-bottom: 1px solid var(--border);
  background: var(--bg-canvas);
}
.rn-toolbar-row { display: flex; align-items: center; gap: 8px; }
.rn-tabs { display: flex; gap: 2px; background: var(--bg-raised); padding: 2px; border-radius: var(--r-md); }
.rn-tab {
  border: none; background: transparent; cursor: pointer;
  font-size: 12px; font-weight: 500; color: var(--text-2);
  padding: 4px 9px; border-radius: 6px;
  display: inline-flex; align-items: center; gap: 4px;
  transition: background .12s ease, color .12s ease;
}
.rn-tab:hover { color: var(--text-1); }
.rn-tab[aria-selected="true"] { background: var(--bg-canvas); color: var(--text-1); box-shadow: var(--sh-card); }
.rn-tab small { font-size: 10.5px; color: var(--text-3); }
.rn-tab-media { min-width: 40px; justify-content: center; }
/* 保存结构：文案较长（独立文件夹 / 统一文件夹），不要压缩 */
.rn-tab-structure { white-space: nowrap; }
.rn-toolbar-right { margin-left: auto; display: flex; align-items: center; gap: 6px; }
.rn-filter { display: flex; align-items: center; gap: 8px; min-width: 0; }
.rn-filter-label { font-size: 12px; color: var(--text-3); white-space: nowrap; }
.rn-selection-line {
  flex: none; padding: 7px 16px 0;
  font-size: 12px; color: var(--text-2);
}

/* ============ 卡片网格 ============ */

.rn-grid {
  display: grid;
  grid-template-columns: repeat(3, 1fr);
  gap: 12px;
  padding: 12px 16px 16px;
}
.rn-grid[data-cols="2"] { grid-template-columns: repeat(2, 1fr); }
.rn-grid[data-cols="1"] { grid-template-columns: 1fr; }

.rn-card {
  position: relative;
  border-radius: var(--r-lg);
  background: var(--bg-raised);
  cursor: pointer;
  border: 2px solid transparent;
  box-shadow: var(--sh-card);
  overflow: hidden;
  transition: border-color .12s ease, box-shadow .12s ease, transform .12s ease;
  user-select: none;
}
.rn-card:hover { box-shadow: var(--sh-card-hov); transform: translateY(-1px); }
.rn-card[data-selected="true"] { border-color: var(--brand); }
.rn-card[data-selected="true"] .rn-check { background: var(--brand); border-color: var(--brand); color: #fff; }
.rn-card[data-state="downloading"] { border-color: var(--brand); }
.rn-card[data-state="completed"] { opacity: .78; }
.rn-card[data-state="failed"] { border-color: var(--danger); }
.rn-card:focus-visible { outline: 2px solid var(--brand); outline-offset: 2px; }

.rn-card-img { position: relative; aspect-ratio: 3 / 4; background: var(--bg-sunken); overflow: hidden; }
.rn-card-img img { width: 100%; height: 100%; object-fit: cover; display: block; }
.rn-card-img .rn-card-empty { position: absolute; inset: 0; display: grid; place-items: center; color: var(--text-3); }

.rn-chip {
  position: absolute; left: 5px; bottom: 5px;
  display: inline-flex; align-items: center; gap: 3px;
  padding: 2px 6px; border-radius: var(--r-sm);
  background: rgba(20,20,25,.55); color: #fff;
  font-size: 11px; font-weight: 500; line-height: 16px;
  backdrop-filter: blur(4px);
}
.rn-chip svg { width: 11px; height: 11px; }
.rn-chip[data-tone="queue"] { left: auto; right: 5px; background: rgba(20,20,25,.45); }

.rn-check {
  position: absolute; right: 6px; top: 6px;
  width: 19px; height: 19px; border-radius: var(--r-sm);
  background: rgba(255,255,255,.92);
  border: 1.5px solid rgba(20,20,25,.35);
  display: grid; place-items: center;
  color: transparent;
  transition: background .12s ease, color .12s ease, transform .12s ease;
}
.rn-check svg { width: 12px; height: 12px; }
.rn-card[data-selected="true"] .rn-check { transform: scale(1.04); }

.rn-card-title {
  padding: 6px 8px 2px;
  font-size: 12px; line-height: 16px;
  color: var(--text-1);
  display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical;
  overflow: hidden; min-height: 32px;
}
.rn-card-meta { padding: 0 8px 8px; font-size: 11px; line-height: 15px; color: var(--text-3); min-height: 15px; }
.rn-card-meta .rn-err { color: var(--danger); }
.rn-card-meta .rn-ok { color: var(--success); }
.rn-card-meta .rn-resolving { display: inline-flex; align-items: center; gap: 4px; color: var(--text-2); }
.rn-card-meta .rn-resolving svg { animation: rn-rotate .9s linear infinite; }

.rn-card-overlay {
  position: absolute; left: 0; right: 0; top: 0; aspect-ratio: 3 / 4;
  background: rgba(16,16,20,.42);
  display: grid; place-items: center;
  pointer-events: none;
}
.rn-ring { transform: rotate(-90deg); }
.rn-ring .track { stroke: rgba(255,255,255,.28); }
.rn-ring .bar { stroke: #fff; stroke-linecap: round; transition: stroke-dashoffset .2s linear; }
.rn-ring-text {
  position: absolute; color: #fff; font-size: 12px; font-weight: 600;
}

/* ============ 底部 ============ */

.rn-footer {
  flex: none;
  display: flex; align-items: center; gap: 8px;
  padding: 12px 16px;
  border-top: 1px solid var(--border);
  background: var(--bg-canvas);
}
.rn-footer-info { flex: 1; min-width: 0; }
.rn-footer-title { font-size: 13px; font-weight: 600; line-height: 18px; }
.rn-footer-sub {
  font-size: 12px; line-height: 16px; color: var(--text-2); margin-top: 1px;
  white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
}
.rn-footer-bar { margin-top: 6px; height: 6px; border-radius: 3px; background: var(--bg-sunken); overflow: hidden; position: relative; }
.rn-footer-bar > i { display: block; height: 100%; width: 0; background: var(--brand); transition: width .2s linear; }
.rn-footer-bar > u { position: absolute; top: 0; bottom: 0; background: var(--danger); opacity: .8; }

/* ============ 队列抽屉 ============ */

.rn-queue {
  flex: none; max-height: 160px; overflow-y: auto;
  border-top: 1px solid var(--border);
  background: var(--bg-raised);
}
.rn-queue-row {
  display: flex; align-items: center; gap: 8px;
  padding: 6px 16px;
}
.rn-queue-row:hover { background: var(--bg-hover); }
.rn-queue-name { flex: 1; min-width: 0; font-size: 12px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.rn-queue-bar { width: 90px; height: 3px; border-radius: 2px; background: var(--bg-sunken); overflow: hidden; flex: none; }
.rn-queue-bar > i { display: block; height: 100%; width: 0; background: var(--brand); }

/* ============ 空状态 / 扫描中 ============ */

.rn-state {
  display: flex; flex-direction: column; align-items: center; justify-content: center;
  gap: 10px; padding: 46px 24px; text-align: center;
}
.rn-state-icon { width: 64px; height: 64px; color: var(--text-3); opacity: .6; }
.rn-state-title { font-size: 15px; font-weight: 600; color: var(--text-1); }
.rn-state-sub { font-size: 13px; line-height: 1.6; color: var(--text-2); max-width: 280px; }
.rn-state-actions { display: flex; gap: 8px; margin-top: 6px; flex-wrap: wrap; justify-content: center; }

.rn-scan {
  display: flex; flex-direction: column; align-items: center; gap: 12px;
  padding: 52px 24px; text-align: center;
}
.rn-scan-spin { color: var(--brand); }
.rn-scan-spin svg { width: 26px; height: 26px; animation: rn-rotate .9s linear infinite; }
.rn-scan-title { font-size: 15px; font-weight: 600; }
.rn-scan-sub { font-size: 13px; color: var(--text-2); }

.rn-indeterminate {
  position: relative; height: 4px; border-radius: 3px; background: var(--bg-sunken); overflow: hidden;
  width: 100%;
}
.rn-indeterminate > i {
  position: absolute; top: 0; bottom: 0; width: 28%;
  border-radius: 3px; background: var(--brand);
  animation: rn-slide 1.2s ease-in-out infinite;
}
@keyframes rn-slide { 0% { left: -30% } 100% { left: 100% } }

.rn-skeleton { display: grid; grid-template-columns: repeat(3, 1fr); gap: 12px; padding: 12px 16px; }
.rn-skel { aspect-ratio: 3/4; border-radius: var(--r-lg); background: var(--bg-raised); animation: rn-pulse 1.4s ease-in-out infinite; }
@keyframes rn-pulse { 0%,100% { opacity: 1 } 50% { opacity: .5 } }

@keyframes rn-rotate { to { transform: rotate(360deg) } }
.rn-spin { animation: rn-rotate .9s linear infinite; transform-origin: center; }

/* ============ 提示条 ============ */

.rn-toasts {
  position: fixed; top: 16px; right: 16px;
  display: flex; flex-direction: column; gap: 8px;
  z-index: 2147483001;
  pointer-events: none;
  max-width: 320px;
}
.rn-toast {
  pointer-events: auto;
  position: relative;
  padding: 10px 12px 10px 14px;
  border-radius: var(--r-lg);
  background: var(--bg-canvas);
  border: 1px solid var(--border);
  box-shadow: var(--sh-toast);
  overflow: hidden;
  animation: rn-toast-in .18s cubic-bezier(.16,1,.3,1);
}
.rn-toast::before { content: ""; position: absolute; left: 0; top: 0; bottom: 0; width: 4px; background: var(--text-3); }
.rn-toast[data-tone="success"]::before { background: var(--success); }
.rn-toast[data-tone="error"]::before { background: var(--danger); }
.rn-toast[data-tone="warning"]::before { background: var(--warning); }
.rn-toast-title { font-size: 13px; font-weight: 600; line-height: 18px; }
.rn-toast-body { font-size: 12px; line-height: 17px; color: var(--text-2); margin-top: 1px; }
.rn-toast-action {
  margin-top: 6px; background: none; border: none; padding: 0;
  font-size: 12px; font-weight: 600; color: var(--brand-text); cursor: pointer;
}
.rn-toast-action:hover { text-decoration: underline; }
.rn-toast-close {
  position: absolute; top: 6px; right: 6px; width: 22px; height: 22px;
  border: none; background: none; color: var(--text-3); cursor: pointer;
  display: grid; place-items: center; border-radius: var(--r-sm);
}
.rn-toast-close:hover { background: var(--bg-hover); color: var(--text-1); }
@keyframes rn-toast-in { from { opacity: 0; transform: translateY(-6px) } to { opacity: 1; transform: none } }

/* ============ 首次引导 ============ */

.rn-coach {
  position: fixed; pointer-events: auto;
  max-width: 230px;
  padding: 12px 14px;
  border-radius: var(--r-lg);
  background: #2A2A32; color: #fff;
  font-size: 12.5px; line-height: 1.55;
  box-shadow: var(--sh-pop);
  z-index: 2147483002;
}
.rn-coach::after {
  content: ""; position: absolute; left: 50%; bottom: -6px;
  width: 12px; height: 12px; background: #2A2A32;
  transform: translateX(-50%) rotate(45deg);
}
.rn-coach-close {
  margin-top: 8px; background: rgba(255,255,255,.14); border: none;
  color: #fff; font-size: 12px; font-weight: 600;
  padding: 4px 10px; border-radius: var(--r-sm); cursor: pointer;
}
.rn-coach-close:hover { background: rgba(255,255,255,.22); }

/* ============ 悬浮在卡片上的快捷下载按钮 ============ */

.rn-hover-btn {
  position: fixed; z-index: 2147482999;
  width: 28px; height: 28px; border-radius: 50%;
  border: none; cursor: pointer;
  background: rgba(255,255,255,.92); color: var(--text-1);
  box-shadow: var(--sh-card-hov);
  display: grid; place-items: center;
  opacity: 0; transform: scale(.85);
  transition: opacity .15s ease, transform .15s ease, background .12s ease, color .12s ease;
}
.rn-hover-btn[data-show="true"] { opacity: 1; transform: none; }
.rn-hover-btn:hover { background: var(--brand); color: #fff; }
.rn-hover-btn svg { width: 15px; height: 15px; }

/* ============ 进度条语义 ============ */

.rn-progress {
  height: 4px; border-radius: 3px; background: var(--bg-sunken); overflow: hidden;
}
.rn-progress > i { display: block; height: 100%; width: 0; background: var(--brand); transition: width .2s linear; }

.rn-visually-hidden {
  position: absolute; width: 1px; height: 1px; padding: 0; margin: -1px;
  overflow: hidden; clip: rect(0 0 0 0); white-space: nowrap; border: 0;
}

@media (max-width: 768px) {
  .rn-panel[data-mode="batch"] { width: auto; left: 0; right: 0; top: 56px; bottom: 0; max-width: none; border-radius: 0; border-left: none; border-right: none; }
  .rn-grid { grid-template-columns: repeat(3, 1fr); gap: 8px; }
}

@media (prefers-reduced-motion: reduce) {
  *, *::before, *::after {
    animation-duration: .001ms !important;
    animation-iteration-count: 1 !important;
    transition-duration: .001ms !important;
  }
}
`;
