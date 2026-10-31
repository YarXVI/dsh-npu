/**
 * dsh-npu 设置面板（浏览器侧）· v1.0.0「燧心 / Hearthcore」
 *
 * 挂载方式：`window.__ModuleLoader__.load` → sidebar.panellist 一个入口 + main（key = PANEL_ID）本体。
 * 路由：/plugins/dsh-npu/panel（同源 cookie 鉴权），只消费契约 §3 冻结的端点。
 *
 * 信息架构（契约 §5）：概览 / 模型 / 设置 三页签。
 *   - 概览：引擎卡（NPU 火种 / GPU 火线 / 混合链路）+ 健康自检 + 一键点火/熄火 + 最近日志 + 本地主权提示
 *   - 模型：槽位表（就地编辑/保存反馈）+ 模型库（FLM / GGUF 两栏）+ 后端五行（含第五框架 amd-hybrid）
 *   - 设置：运行环境 / 服务 / 混合推理（含基准）/ 框架更新 / 诊断
 *
 * 视觉纪律：DSH 原生（整宽发丝行、药丸按钮、34×20 开关、11.5px 等宽路径）；
 * 深浅色跟随系统，`html[data-dnp-theme]` 可覆盖；全部写操作 busy 态禁用；错误一律行内红字。
 */
window.__ModuleLoader__.load({
  id: 'dsh-npu',
  factory: (require) => {
    const React = require('react')
    const h = React.createElement
    const { useEffect, useState, useCallback, useRef } = React

    const PANEL_ID = 'dsh-npu-panel'
    const ROUTE = '/plugins/dsh-npu/panel'
    const STYLE_ID = 'dsh-npu-panel-style'
    const THEME_KEY = 'dsh-npu-theme'
    const POLL_MS = 3000

    const TABS = [
      { id: 'overview', label: '概览' },
      { id: 'models', label: '模型' },
      { id: 'settings', label: '设置' },
    ]

    /* 契约 §3：POST config / POST hybrid/config 的 body 形态是 `{ patch: {...} }`。
     * 若后端直接合并 body，把下面这行改成 `const patchBody = (patch) => patch`。 */
    const patchBody = (patch) => ({ patch })

    const css = `
/* ═══════════════ tokens：DSH 原生（dark 默认 + 系统浅色 + html[data-dnp-theme] 覆盖） ═══════════════ */
.dnp-page {
  --hr: rgba(255, 255, 255, .07);
  --title: #e8e9ec; --desc: #8a8f98; --body: #d7dade;
  --pill-bg: #2b2d31; --pill-bg-hover: #33363b; --pill-fg: #d7dade;
  --track: #3a3d43; --ok: #2ea06b; --brand: #4d7cff; --brand-solid: #3f6ae8;
  --danger: #e0645c; --danger-solid: #c0453c; --warn: #d9a441;
  --badge: rgba(77, 124, 255, .16); --badge-ok: rgba(46, 160, 107, .16);
  --badge-warn: rgba(217, 164, 65, .16); --badge-danger: rgba(224, 100, 92, .16);
  --card-bg: rgba(255, 255, 255, .022);
  --mono: ui-monospace, "Cascadia Mono", Consolas, "SFMono-Regular", Menlo, monospace;
  color-scheme: dark;
}
@media (prefers-color-scheme: light) {
  .dnp-page {
    --hr: rgba(0, 0, 0, .09);
    --title: #1c1d20; --desc: #61666b; --body: #33363b;
    --pill-bg: #f1f2f4; --pill-bg-hover: #e6e8eb; --pill-fg: #33363b;
    --track: #d8dade; --ok: #1c8a5b; --brand: #2f6fed; --brand-solid: #2f6fed;
    --danger: #b93a32; --danger-solid: #b2352d; --warn: #8a6414;
    --badge: rgba(47, 111, 237, .12); --badge-ok: rgba(28, 138, 91, .13);
    --badge-warn: rgba(138, 100, 20, .13); --badge-danger: rgba(185, 58, 50, .1);
    --card-bg: #fafafa;
    color-scheme: light;
  }
}
html[data-dnp-theme="dark"] .dnp-page {
  --hr: rgba(255, 255, 255, .07);
  --title: #e8e9ec; --desc: #8a8f98; --body: #d7dade;
  --pill-bg: #2b2d31; --pill-bg-hover: #33363b; --pill-fg: #d7dade;
  --track: #3a3d43; --ok: #2ea06b; --brand: #4d7cff; --brand-solid: #3f6ae8;
  --danger: #e0645c; --danger-solid: #c0453c; --warn: #d9a441;
  --badge: rgba(77, 124, 255, .16); --badge-ok: rgba(46, 160, 107, .16);
  --badge-warn: rgba(217, 164, 65, .16); --badge-danger: rgba(224, 100, 92, .16);
  --card-bg: rgba(255, 255, 255, .022); color-scheme: dark;
}
html[data-dnp-theme="light"] .dnp-page {
  --hr: rgba(0, 0, 0, .09);
  --title: #1c1d20; --desc: #61666b; --body: #33363b;
  --pill-bg: #f1f2f4; --pill-bg-hover: #e6e8eb; --pill-fg: #33363b;
  --track: #d8dade; --ok: #1c8a5b; --brand: #2f6fed; --brand-solid: #2f6fed;
  --danger: #b93a32; --danger-solid: #b2352d; --warn: #8a6414;
  --badge: rgba(47, 111, 237, .12); --badge-ok: rgba(28, 138, 91, .13);
  --badge-warn: rgba(138, 100, 20, .13); --badge-danger: rgba(185, 58, 50, .1);
  --card-bg: #fafafa; color-scheme: light;
}

/* ═══════════════ 页面骨架 ═══════════════ */
.dnp-page {
  color: var(--body);
  padding: 14px 20px 44px; box-sizing: border-box;
  height: 100%; max-height: 100%; overflow-y: auto; overscroll-behavior: contain;
  font-size: 14px; line-height: 1.55; background: transparent;
  font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC", "Microsoft YaHei", system-ui, sans-serif;
  -webkit-font-smoothing: antialiased;
}
.dnp-wrap { max-width: 860px; margin: 0 auto; }

.dnp-head { display: flex; align-items: flex-start; justify-content: space-between; gap: 12px; flex-wrap: wrap; padding: 2px 0 0; }
.dnp-h1 { margin: 0; font-size: 17px; font-weight: 600; color: var(--title); letter-spacing: .2px; }
.dnp-sub { margin-top: 3px; font-size: 12px; color: var(--desc); display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }

/* 页签：药丸底 + 品牌色下沿（原生设置页签形态） */
.dnp-tabs { display: flex; gap: 4px; margin: 14px 0 0; border-bottom: 1px solid var(--hr); }
.dnp-tab {
  font: inherit; font-size: 13px; line-height: 1.5; padding: 7px 14px; border: 0; cursor: pointer;
  background: transparent; color: var(--desc); border-radius: 8px 8px 0 0; white-space: nowrap;
}
.dnp-tab:hover { background: var(--pill-bg); color: var(--title); }
.dnp-tab[aria-selected="true"] {
  background: var(--pill-bg); color: var(--title); font-weight: 500;
  box-shadow: inset 0 -2px 0 var(--brand);
}

/* ═══════════════ 分区与整宽发丝行 ═══════════════ */
.dnp-sect { margin-top: 22px; }
.dnp-sect:first-of-type { margin-top: 16px; }
.dnp-h2 {
  margin: 0 0 6px; padding: 0; font-size: 13px; font-weight: 600; color: var(--title);
  display: flex; align-items: center; gap: 8px; flex-wrap: wrap;
}
.dnp-h2-sub { font-weight: 400; font-size: 11.5px; color: var(--desc); }
.dnp-h2-right { margin-left: auto; display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }

.dnp-card { background: transparent; border: 0; border-radius: 0; }
.dnp-row { display: flex; align-items: center; gap: 16px; padding: 13px 0; border-top: 1px solid var(--hr); }
.dnp-row:first-child { border-top: 1px solid var(--hr); }
.dnp-row-main { flex: 1; min-width: 0; }
.dnp-row-title { display: flex; align-items: center; gap: 7px; flex-wrap: wrap; font-size: 13.5px; font-weight: 500; color: var(--title); line-height: 1.45; }
.dnp-row-desc { margin-top: 2px; font-size: 12px; color: var(--desc); line-height: 1.5; word-break: break-word; }
.dnp-row-ctl { flex: none; display: flex; align-items: center; gap: 8px; flex-wrap: wrap; justify-content: flex-end; }
.dnp-row.stack { align-items: flex-start; }
.dnp-row.stack .dnp-row-ctl { padding-top: 2px; }

.dnp-inline { display: flex; align-items: center; gap: 6px; flex-wrap: wrap; margin-top: 6px; }
.dnp-label { font-size: 11.5px; color: var(--desc); white-space: nowrap; }

/* ═══════════════ 32×20 开关 ═══════════════ */
.dnp-switch {
  width: 34px; height: 20px; border-radius: 999px; background: var(--track);
  position: relative; flex: none; cursor: pointer; border: 0; padding: 0;
}
.dnp-switch::after {
  content: ""; position: absolute; top: 2px; left: 2px; width: 16px; height: 16px; border-radius: 50%;
  background: #fff; box-shadow: 0 1px 2px rgba(0, 0, 0, .25); transition: left .12s ease;
}
.dnp-switch.on { background: var(--ok); }
.dnp-switch.on::after { left: auto; right: 2px; }
.dnp-switch:disabled { opacity: .45; cursor: default; }

/* ═══════════════ 徽标 ═══════════════ */
.dnp-tag {
  font-size: 11px; line-height: 17px; padding: 0 6px; border-radius: 5px;
  background: var(--badge); color: var(--brand); font-weight: 500; white-space: nowrap;
}
.dnp-tag.ok { background: var(--badge-ok); color: var(--ok); }
.dnp-tag.warn { background: var(--badge-warn); color: var(--warn); }
.dnp-tag.fail { background: var(--badge-danger); color: var(--danger); }
.dnp-tag.mute { background: var(--pill-bg); color: var(--desc); }

/* ═══════════════ 药丸按钮 ═══════════════ */
.dnp-btn {
  display: inline-flex; align-items: center; justify-content: center; gap: 6px;
  font: inherit; font-size: 13px; line-height: 1.5; padding: 5px 11px; border-radius: 8px;
  border: 0; background: var(--pill-bg); color: var(--pill-fg); cursor: pointer; white-space: nowrap;
}
.dnp-btn:hover:not(:disabled) { background: var(--pill-bg-hover); }
.dnp-btn:disabled { opacity: .45; cursor: default; }
.dnp-btn.primary { background: var(--brand-solid); color: #fff; }
.dnp-btn.primary:hover:not(:disabled) { filter: brightness(1.08); background: var(--brand-solid); }
.dnp-btn.small { padding: 3px 9px; font-size: 12px; border-radius: 7px; }
.dnp-btn.ghost { background: transparent; color: var(--desc); }
.dnp-btn.ghost:hover:not(:disabled) { color: var(--title); background: var(--pill-bg); }
.dnp-btn.danger { background: transparent; color: var(--danger); padding-left: 5px; padding-right: 5px; }
.dnp-btn.danger:hover:not(:disabled) { background: var(--badge-danger); }
.dnp-btn.danger-solid { background: var(--danger-solid); color: #fff; }
.dnp-btn.danger-solid:hover:not(:disabled) { filter: brightness(1.06); }

.dnp-bigbtn {
  font: inherit; font-size: 14px; font-weight: 500; padding: 9px 20px; border-radius: 10px; border: 0;
  background: var(--brand-solid); color: #fff; cursor: pointer; display: inline-flex; align-items: center; gap: 8px;
  white-space: nowrap;
}
.dnp-bigbtn:hover:not(:disabled) { filter: brightness(1.08); }
.dnp-bigbtn.stop { background: transparent; color: var(--danger); border: 1px solid var(--hr); }
.dnp-bigbtn.stop:hover:not(:disabled) { background: var(--badge-danger); filter: none; }
.dnp-bigbtn:disabled { opacity: .5; cursor: default; }

/* ═══════════════ 输入 ═══════════════ */
.dnp-input, .dnp-select {
  font: inherit; font-size: 13px; color: var(--body); border: 1px solid transparent; border-radius: 8px;
  padding: 5px 10px; background: var(--pill-bg); box-sizing: border-box; min-width: 0;
}
.dnp-input:focus, .dnp-select:focus, .dnp-tab:focus-visible, .dnp-btn:focus-visible,
.dnp-switch:focus-visible, .dnp-bigbtn:focus-visible {
  outline: 2px solid var(--brand); outline-offset: 2px;
}
.dnp-input.mono { font-family: var(--mono); font-size: 12px; }
.dnp-input.wide { width: 320px; max-width: 100%; }
.dnp-input.narrow { width: 104px; }
.dnp-input.mini { width: 68px; }
.dnp-input:disabled, .dnp-select:disabled { opacity: .55; }
.dnp-select { appearance: none; padding-right: 24px;
  background-image: url("data:image/svg+xml;utf8,<svg xmlns='http://www.w3.org/2000/svg' width='8' height='5'><path d='M1 1l3 3 3-3' stroke='%238a8f98' stroke-width='1.3' fill='none' stroke-linecap='round'/></svg>");
  background-repeat: no-repeat; background-position: right 9px center; }

/* ═══════════════ 引擎卡 ═══════════════ */
.dnp-engines {
  display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); margin-top: 8px;
  border: 1px solid var(--hr); border-radius: 12px; overflow: hidden; background: var(--card-bg);
}
.dnp-engine { padding: 13px 15px; display: flex; flex-direction: column; gap: 3px; border-left: 1px solid var(--hr); min-width: 0; }
.dnp-engine:first-child { border-left: 0; }
.dnp-eng-name { display: flex; align-items: center; gap: 7px; font-size: 13px; font-weight: 500; color: var(--title); }
.dnp-eng-state { font-size: 11.5px; color: var(--desc); }
.dnp-eng-meta { font-size: 11.5px; color: var(--desc); font-family: var(--mono); word-break: break-all; line-height: 1.5; }

.dnp-dot { width: 8px; height: 8px; border-radius: 50%; background: var(--desc); flex: none; display: inline-block; }
.dnp-dot.ok { background: var(--ok); box-shadow: 0 0 0 3px var(--badge-ok); }
.dnp-dot.warn { background: var(--warn); box-shadow: 0 0 0 3px var(--badge-warn); }
.dnp-dot.fail { background: var(--danger); box-shadow: 0 0 0 3px var(--badge-danger); }
.dnp-dot.off { background: var(--track); }

.dnp-action { display: flex; align-items: center; gap: 14px; padding: 14px 0; border-top: 1px solid var(--hr); flex-wrap: wrap; }
.dnp-action-text { flex: 1 1 220px; min-width: 0; font-size: 12px; color: var(--desc); }

/* ═══════════════ 健康自检 ═══════════════ */
.dnp-health { list-style: none; margin: 8px 0 0; padding: 0; border: 1px solid var(--hr); border-radius: 12px; overflow: hidden; }
.dnp-health li { display: flex; align-items: center; gap: 10px; padding: 10px 14px; border-top: 1px solid var(--hr); flex-wrap: wrap; }
.dnp-health li:first-child { border-top: 0; }
.dnp-ico { flex: none; width: 18px; height: 18px; border-radius: 50%; display: inline-flex; align-items: center; justify-content: center; font-size: 11px; font-weight: 600; line-height: 1; }
.dnp-ico.ok { background: var(--badge-ok); color: var(--ok); }
.dnp-ico.warn { background: var(--badge-warn); color: var(--warn); }
.dnp-ico.fail { background: var(--badge-danger); color: var(--danger); }
.dnp-health-main { flex: 1 1 220px; min-width: 0; }
.dnp-health-label { font-size: 13px; color: var(--title); }
.dnp-health-detail { font-size: 11.5px; color: var(--desc); word-break: break-word; }
.dnp-health li .dnp-h2-right { margin-left: auto; }

/* ═══════════════ 日志 ═══════════════ */
.dnp-logs {
  margin-top: 8px; border: 1px solid var(--hr); border-radius: 12px; background: var(--card-bg);
  padding: 9px 12px; font-family: var(--mono); font-size: 11.5px; line-height: 1.75;
  max-height: 168px; overflow: auto;
}
.dnp-log-line { white-space: pre-wrap; word-break: break-all; color: var(--body); }
.dnp-log-line > .t { color: var(--desc); }
.dnp-empty { padding: 12px 13px; border-radius: 10px; background: var(--pill-bg); color: var(--desc); font-size: 12.5px; line-height: 1.6; word-break: break-word; }
.dnp-empty code { font-family: var(--mono); font-size: 11.5px; }

/* 本地主权提示 */
.dnp-sovereign {
  display: flex; align-items: flex-start; gap: 10px; margin-top: 14px; padding: 11px 13px;
  border: 1px solid var(--hr); border-radius: 11px; background: var(--card-bg); font-size: 12px; color: var(--desc);
  line-height: 1.55;
}
.dnp-sovereign b { color: var(--title); font-weight: 500; }

/* ═══════════════ 槽位表（宽屏网格 / 窄屏换行，不横向滚动） ═══════════════ */
.dnp-tbl { margin-top: 8px; border: 1px solid var(--hr); border-radius: 12px; overflow: hidden; }
.dnp-tbl-head {
  display: grid; gap: 10px; padding: 9px 14px; font-size: 11.5px; color: var(--desc);
  background: var(--card-bg); border-bottom: 1px solid var(--hr);
  grid-template-columns: minmax(0, 2.2fr) 92px 64px 70px 40px 104px 112px;
}
.dnp-tbl-head > .r { text-align: right; }
.dnp-slot {
  display: grid; gap: 10px; align-items: center; padding: 10px 14px;
  border-top: 1px solid var(--hr); font-size: 13px; color: var(--body);
  grid-template-columns: minmax(0, 2.2fr) 92px 64px 70px 40px 104px 112px;
}
.dnp-cell { min-width: 0; overflow-wrap: break-word; word-break: break-word; }
.dnp-cell.num { font-family: var(--mono); font-size: 12px; color: var(--desc); }
.dnp-cell.model > .n { font-size: 13px; color: var(--title); display: flex; align-items: center; gap: 6px; flex-wrap: wrap; }
.dnp-cell.model > .m { font-family: var(--mono); font-size: 11.5px; color: var(--desc); word-break: break-all; line-height: 1.5; }
.dnp-cell.act { display: flex; align-items: center; justify-content: flex-end; gap: 6px; flex-wrap: wrap; }
.dnp-cell.load { display: flex; align-items: center; gap: 6px; flex-wrap: wrap; }
.dnp-cell.sw { display: flex; align-items: center; }

.dnp-editor {
  padding: 11px 14px 13px; border-top: 1px solid var(--hr); background: var(--card-bg);
  display: flex; flex-wrap: wrap; gap: 10px 16px; align-items: flex-end;
}
.dnp-field { display: flex; flex-direction: column; gap: 4px; min-width: 0; }
.dnp-field > label { font-size: 11px; color: var(--desc); }
.dnp-editor-actions { display: flex; gap: 8px; align-items: center; flex-wrap: wrap; margin-left: auto; }

.dnp-confirm {
  display: flex; align-items: center; gap: 10px; flex-wrap: wrap; padding: 10px 14px;
  border-top: 1px solid var(--hr); background: var(--badge-danger); font-size: 12.5px; color: var(--body);
}
.dnp-confirm > .q { flex: 1 1 200px; min-width: 0; }
.dnp-confirm-actions { display: flex; gap: 8px; align-items: center; flex-wrap: wrap; }

/* ═══════════════ 模型库两栏 ═══════════════ */
.dnp-lib { display: grid; grid-template-columns: 1fr 1fr; gap: 18px; margin-top: 8px; }
.dnp-lib-col { border: 1px solid var(--hr); border-radius: 12px; overflow: hidden; }
.dnp-lib-head {
  display: flex; align-items: center; gap: 8px; flex-wrap: wrap; padding: 9px 13px;
  font-size: 12.5px; font-weight: 500; color: var(--title); background: var(--card-bg);
  border-bottom: 1px solid var(--hr);
}
.dnp-lib-head .meta { font-weight: 400; font-size: 11.5px; color: var(--desc); font-family: var(--mono); word-break: break-all; }
.dnp-lib-item { display: flex; align-items: center; gap: 9px; padding: 9px 13px; border-top: 1px solid var(--hr); flex-wrap: wrap; }
.dnp-lib-item:first-child { border-top: 0; }
.dnp-lib-main { flex: 1 1 130px; min-width: 0; }
.dnp-lib-name { font-size: 12.5px; color: var(--title); word-break: break-all; }
.dnp-lib-meta { font-size: 11.5px; color: var(--desc); font-family: var(--mono); word-break: break-all; line-height: 1.5; }
.dnp-lib-item .ctl { display: flex; gap: 6px; align-items: center; flex-wrap: wrap; margin-left: auto; }

/* ═══════════════ 进度（真实百分比；无总量时用不确定条，绝不假 0%） ═══════════════ */
.dnp-progress { margin: 6px 0 2px; height: 6px; border-radius: 999px; background: var(--track); overflow: hidden; }
.dnp-progress > i { display: block; height: 100%; background: var(--brand); border-radius: 999px; transition: width .25s linear; }
.dnp-progress.indet > i { width: 34%; animation: dnp-slide 1.15s ease-in-out infinite; }
@keyframes dnp-slide { 0% { margin-left: -34%; } 100% { margin-left: 100%; } }
.dnp-hint { font-size: 11.5px; color: var(--desc); word-break: break-word; }
.dnp-err { margin: 8px 0 0; font-size: 12px; color: var(--danger); }
.dnp-note { margin: 8px 0 0; font-size: 12px; color: var(--ok); }
.dnp-err-inline { font-size: 11.5px; color: var(--danger); word-break: break-word; }
.dnp-code { font-family: var(--mono); font-size: 11.5px; color: var(--desc); word-break: break-all; }

/* ═══════════════ 基准表 ═══════════════ */
.dnp-bench { width: 100%; border-collapse: collapse; margin-top: 10px; font-size: 12.5px; }
.dnp-bench th, .dnp-bench td { text-align: left; padding: 7px 10px; border-top: 1px solid var(--hr); }
.dnp-bench th { color: var(--desc); font-size: 11.5px; font-weight: 500; }
.dnp-bench td.num, .dnp-bench th.num { font-family: var(--mono); text-align: right; }

/* ═══════════════ 混合模式瓦片 ═══════════════ */
.dnp-tiles { display: grid; grid-template-columns: repeat(5, minmax(0, 1fr)); gap: 8px; margin-top: 8px; }
.dnp-tile {
  font: inherit; text-align: left; padding: 9px 10px; border-radius: 10px; border: 1px solid var(--hr);
  background: transparent; color: var(--pill-fg); cursor: pointer; min-width: 0;
}
.dnp-tile:hover:not(:disabled) { background: var(--pill-bg); }
.dnp-tile[aria-pressed="true"] { border-color: var(--brand); background: var(--badge); }
.dnp-tile:disabled { opacity: .5; cursor: default; }
.dnp-tile-name { font-size: 12.5px; font-weight: 500; color: var(--title); }
.dnp-tile-desc { margin-top: 2px; font-size: 11px; color: var(--desc); line-height: 1.45; }

/* 引擎卡下方的「当前」事实条 */
.dnp-facts {
  display: flex; gap: 8px 22px; flex-wrap: wrap; align-items: center;
  padding: 10px 2px; font-size: 12px; color: var(--desc); border-bottom: 1px solid var(--hr);
}
.dnp-facts b { color: var(--title); font-weight: 500; }
.dnp-facts > span { min-width: 0; word-break: break-word; }

/* 配置自检提醒 */
.dnp-warnbox {
  margin-top: 20px; padding: 11px 13px; border: 1px solid var(--hr); border-radius: 11px;
  background: var(--badge-warn); font-size: 12px; color: var(--body);
}
.dnp-warn-line { margin-top: 4px; color: var(--warn); font-size: 11.5px; word-break: break-word; }

/* ═══════════════ 响应式：980 以下网格收成换行标签块 ═══════════════ */
@media (max-width: 980px) {
  .dnp-page { padding: 12px 14px 40px; }
  .dnp-tbl-head { display: none; }
  .dnp-slot { display: flex; flex-wrap: wrap; align-items: flex-start; gap: 8px 18px; padding: 11px 13px; }
  .dnp-slot > .dnp-cell { flex: 0 0 auto; }
  .dnp-slot > .dnp-cell.model { flex: 1 1 100%; }
  .dnp-slot > .dnp-cell[data-label]::before {
    content: attr(data-label); display: block; font-size: 10.5px; color: var(--desc); margin-bottom: 1px; font-weight: 400;
  }
  .dnp-slot > .dnp-cell.act { flex: 1 1 100%; justify-content: flex-start; }
  .dnp-slot > .dnp-cell.sw, .dnp-slot > .dnp-cell.load { align-items: flex-end; }
  .dnp-lib { grid-template-columns: 1fr; gap: 14px; }
  .dnp-tiles { grid-template-columns: repeat(3, minmax(0, 1fr)); }
}
@media (max-width: 720px) {
  .dnp-engines { grid-template-columns: 1fr; }
  .dnp-engine { border-left: 0; border-top: 1px solid var(--hr); }
  .dnp-engine:first-child { border-top: 0; }
  .dnp-row { flex-wrap: wrap; }
  .dnp-row-ctl { margin-left: auto; }
  .dnp-tiles { grid-template-columns: repeat(2, minmax(0, 1fr)); }
  .dnp-h1 { font-size: 16px; }
}
@media (max-width: 560px) {
  .dnp-input.wide { width: 100%; }
  .dnp-inline { width: 100%; }
  .dnp-tiles { grid-template-columns: 1fr; }
}
`

    function ensureStyle() {
      if (typeof document === 'undefined') return
      if (document.getElementById(STYLE_ID)) return
      const el = document.createElement('style')
      el.id = STYLE_ID
      el.textContent = css
      document.head.appendChild(el)
    }

    /* ────────────────────────── 工具函数 ────────────────────────── */

    const cx = (...parts) => parts.filter(Boolean).join(' ')
    const has = (v) => v !== undefined && v !== null
    const num = (v, dflt) => {
      const n = Number(v)
      return Number.isFinite(n) ? n : dflt
    }
    const clone = (v) => { try { return JSON.parse(JSON.stringify(v)) } catch { return v } }

    /** 任何错误都以「人能读的字符串」呈现，绝不出现 [object Object] */
    function errText(err) {
      if (err === undefined || err === null) return '未知错误'
      if (typeof err === 'string') return err
      if (typeof err.message === 'string' && err.message) return err.message
      if (err.payload) {
        const p = err.payload
        if (typeof p.error === 'string' && p.error) return p.error
        if (p.error && typeof p.error.message === 'string' && p.error.message) return p.error.message
        if (typeof p.message === 'string' && p.message) return p.message
      }
      if (typeof err.error === 'string' && err.error) return err.error
      if (err.error && typeof err.error.message === 'string' && err.error.message) return err.error.message
      if (typeof err.status === 'number' && err.status) return 'HTTP ' + err.status
      try {
        const s = JSON.stringify(err)
        if (s && s !== '{}') return s.length > 300 ? s.slice(0, 300) + '…' : s
      } catch { /* 忽略 */ }
      return '未知错误'
    }

    function fmtSize(bytes) {
      const b = Number(bytes) || 0
      if (!b) return '0 B'
      const mb = b / 1048576
      if (mb >= 1024) return (mb / 1024).toFixed(2) + ' GB'
      if (mb >= 10) return Math.round(mb) + ' MB'
      if (mb >= 1) return mb.toFixed(1) + ' MB'
      return Math.max(1, Math.round(b / 1024)) + ' KB'
    }
    const fmtIdle = (v) => (num(v, 0) > 0 ? num(v, 0) + ' 秒' : '不回收')
    const fmtTime = (ts) => {
      if (!ts) return '—'
      const d = new Date(Number(ts) || ts)
      if (isNaN(d.getTime())) return String(ts)
      const p = (n) => String(n).padStart(2, '0')
      return p(d.getHours()) + ':' + p(d.getMinutes()) + ':' + p(d.getSeconds())
    }
    const fmtStamp = (ts) => {
      if (!ts) return '—'
      const d = new Date(Number(ts) || ts)
      if (isNaN(d.getTime())) return String(ts)
      return d.toLocaleString()
    }

    /** 同源 cookie + JSON + 契约错误统一提取 error.message */
    async function api(suffix, init) {
      const url = ROUTE + (suffix ? '/' + String(suffix).replace(/^\/+/, '') : '')
      const opts = { credentials: 'same-origin', headers: { accept: 'application/json' } }
      if (init && init.body !== undefined) {
        opts.method = 'POST'
        opts.headers['content-type'] = 'application/json'
        opts.body = JSON.stringify(init.body)
      }
      if (init && init.method) opts.method = init.method
      let res
      try {
        res = await fetch(url, opts)
      } catch (e) {
        throw new Error('连不上插件后端：' + errText(e))
      }
      let text = ''
      try { text = await res.text() } catch { text = '' }
      let json = null
      try { json = text ? JSON.parse(text) : null } catch { json = null }
      if (!res.ok || (json && json.ok === false)) {
        const message = json ? errText(json.error) : (text ? text.slice(0, 300) : 'HTTP ' + res.status)
        const err = new Error(message)
        err.status = res.status
        err.payload = json
        throw err
      }
      return json || {}
    }

    /* ────────────────────────── 纯展示组件 ────────────────────────── */

    function Dot({ state }) {
      return h('span', { className: cx('dnp-dot', state), 'aria-hidden': 'true' })
    }

    function Tag({ tone, children }) {
      return h('span', { className: cx('dnp-tag', tone) }, children)
    }

    function Switch({ on, disabled, onChange, label, testid }) {
      return h('button', {
        type: 'button',
        className: cx('dnp-switch', on && 'on'),
        role: 'switch',
        'aria-checked': on ? 'true' : 'false',
        'aria-label': label || '开关',
        title: label || '',
        disabled: !!disabled,
        'data-dnp': testid,
        onClick: () => { if (!disabled) onChange(!on) },
      })
    }

    function Btn({ tone, small, disabled, onClick, children, title, testid, ariaLabel }) {
      return h('button', {
        type: 'button',
        className: cx('dnp-btn', tone, small && 'small'),
        disabled: !!disabled,
        onClick,
        title: title || undefined,
        'aria-label': ariaLabel || undefined,
        'data-dnp': testid,
      }, children)
    }

    function Row({ title, desc, ctl, stack, children }) {
      return h('div', { className: cx('dnp-row', stack && 'stack') },
        h('div', { className: 'dnp-row-main' },
          h('div', { className: 'dnp-row-title' }, title),
          desc ? h('div', { className: 'dnp-row-desc' }, desc) : null,
          children || null),
        ctl ? h('div', { className: 'dnp-row-ctl' }, ctl) : null)
    }

    function Sect({ title, sub, right, children }) {
      return h('section', { className: 'dnp-sect' },
        h('div', { className: 'dnp-h2' }, title,
          sub ? h('span', { className: 'dnp-h2-sub' }, sub) : null,
          right ? h('span', { className: 'dnp-h2-right' }, right) : null),
        children)
    }

    function Note({ f }) {
      if (!f || !f.text) return null
      const err = f.kind === 'err'
      return h('div', {
        className: err ? 'dnp-err' : 'dnp-note',
        role: err ? 'alert' : 'status',
        'aria-live': err ? 'assertive' : 'polite',
        'data-dnp': err ? 'inline-error' : 'inline-note',
      }, f.text)
    }

    function Progress({ p }) {
      if (!p) return null
      const got = num(p.got, 0)
      const total = num(p.total, 0)
      const pct = total > 0 ? Math.max(0, Math.min(100, Math.round((got / total) * 100))) : null
      const failed = p.state === 'error'
      const done = p.state === 'done'
      if (failed) {
        return h('div', { style: { width: '100%' } },
          h('div', { className: 'dnp-hint', style: { color: 'var(--danger)' } }, '下载失败：' + (p.error || '未知错误')))
      }
      return h('div', { style: { width: '100%' }, 'data-dnp': 'progress' },
        pct === null
          ? h('div', { className: 'dnp-progress indet' }, h('i', null))
          : h('div', {
              className: 'dnp-progress',
              role: 'progressbar',
              'aria-valuemin': 0, 'aria-valuemax': 100, 'aria-valuenow': pct,
              'aria-label': '下载进度 ' + pct + '%',
            }, h('i', { style: { width: pct + '%' } })),
        h('div', { className: 'dnp-hint' }, done
          ? '已完成'
          : ('下载中 ' + fmtSize(got) + (total > 0 ? ' / ' + fmtSize(total) + '（' + pct + '%）' : '（总大小未知）'))))
    }

    /** 危险操作：两段式行内确认（不用原生 confirm，键盘可达） */
    function DangerAction({ children, question, onConfirm, disabled, testid }) {
      const [ask, setAsk] = useState(false)
      const [busy, setBusy] = useState(false)
      const [err, setErr] = useState('')
      if (!ask) {
        return h('button', {
          type: 'button',
          className: 'dnp-btn danger small',
          disabled: !!disabled,
          'data-dnp': testid,
          onClick: () => { setErr(''); setAsk(true) },
        }, children)
      }
      return h('span', { className: 'dnp-inline', style: { marginTop: 0 }, role: 'group', 'aria-label': '确认操作' },
        h('span', { style: { fontSize: 11.5, color: 'var(--warn)' } }, question || '确定？'),
        h('button', { type: 'button', className: 'dnp-btn small', disabled: busy, onClick: () => setAsk(false) }, '取消'),
        h('button', {
          type: 'button', className: 'dnp-btn danger-solid small', disabled: busy,
          'data-dnp': (testid || 'danger') + '-confirm',
          onClick: async () => {
            setBusy(true); setErr('')
            try { await onConfirm(); setAsk(false) }
            catch (e) { setErr(errText(e)) }
            finally { setBusy(false) }
          },
        }, busy ? '处理中…' : '确认'),
        err ? h('span', { className: 'dnp-err-inline', role: 'alert' }, err) : null)
    }

    /* ────────────────────────── state 读取（容错：字段缺失时优雅降级） ────────────────────────── */

    const cfgOf = (s) => (s && s.config) || {}

    function slotsOf(s) {
      const slots = cfgOf(s).slots
      return Array.isArray(slots) ? slots : []
    }

    function statusSlotsOf(s) {
      const st = (s && s.status) || {}
      return Array.isArray(st.slots) ? st.slots : []
    }

    function healthOf(s) {
      const items = s && s.health && s.health.items
      return Array.isArray(items) ? items : []
    }

    function modelsOf(s) {
      const m = (s && s.models) || {}
      return {
        flm: Array.isArray(m.flm) ? m.flm : [],
        gguf: Array.isArray(m.gguf) ? m.gguf : [],
      }
    }

    /** 契约 §3 GET backends = {chosen, devices, skipped, backends[]}；state.backends 兼容数组形态 */
    function backendsOf(s) {
      const raw = s && s.backends
      if (Array.isArray(raw)) return { chosen: null, devices: [], skipped: [], backends: raw }
      const b = raw || {}
      return {
        chosen: b.chosen || null,
        devices: Array.isArray(b.devices) ? b.devices : [],
        skipped: Array.isArray(b.skipped) ? b.skipped : [],
        backends: Array.isArray(b.backends) ? b.backends : [],
      }
    }

    function hybridOf(s) {
      const hy = (s && s.hybrid) || {}
      const ch = cfgOf(s).hybrid || {}
      return {
        enabled: has(hy.enabled) ? !!hy.enabled : ch.enabled !== false,
        mode: hy.mode || ch.mode || 'auto',
        draftModel: hy.draftModel || ch.draftModel || '',
        verifyModel: hy.verifyModel || ch.verifyModel || '',
        shortQueryTokens: num(has(hy.shortQueryTokens) ? hy.shortQueryTokens : ch.shortQueryTokens, 48),
        raceTimeoutMs: num(has(hy.raceTimeoutMs) ? hy.raceTimeoutMs : ch.raceTimeoutMs, 12000),
        engines: Array.isArray(hy.engines) ? hy.engines : [],
        last: hy.last || null,
        active: hy.active,
      }
    }

    function updatesOf(s) {
      const u = (s && s.updates) || {}
      return {
        items: Array.isArray(u.items) ? u.items : [],
        checkedAt: u.checkedAt || null,
        progress: u.progress || null,
      }
    }

    const BACKEND_ORDER = ['flm', 'llamacpp-vulkan', 'llamacpp-rocm', 'llamacpp-cuda']
    const BACKEND_LABEL = {
      flm: 'FLM · AMD NPU',
      'llamacpp-vulkan': 'llama.cpp · Vulkan',
      'llamacpp-rocm': 'llama.cpp · ROCm',
      'llamacpp-cuda': 'llama.cpp · CUDA',
      'amd-hybrid': 'AMD 混合推理 · 第五框架',
    }
    const backendLabel = (id, list) => {
      const hit = (list || []).find((b) => b && b.id === id)
      return (hit && hit.label) || BACKEND_LABEL[id] || id || '未知后端'
    }

    const HYBRID_MODES = [
      { id: 'auto', name: 'auto', desc: '按引擎就绪情况自动选' },
      { id: 'route', name: 'route', desc: '按请求类型分流' },
      { id: 'race', name: 'race', desc: '双引擎竞速，先答者胜' },
      { id: 'cascade', name: 'cascade', desc: '短问题先 NPU，不够再升级' },
      { id: 'augment', name: 'augment', desc: 'NPU 先增强，再交 GPU' },
    ]

    /* ────────────────────────── 槽位行（就地编辑 + 就地保存反馈） ────────────────────────── */

    function SlotRow({ slot, info, label, choices, disabled, onSave, onDelete, onWarm, onEvict }) {
      const [editing, setEditing] = useState(false)
      const [draft, setDraft] = useState(null)
      const [busy, setBusy] = useState(false)
      const [flash, setFlash] = useState(null)
      const [confirm, setConfirm] = useState(false)
      const [enabled, setEnabled] = useState(slot.enabled !== false)

      useEffect(() => { setEnabled(slot.enabled !== false) }, [slot.enabled, slot.id])

      const blocked = !!disabled || busy
      const ready = !!(info && info.ready)
      const running = !!(info && (info.ready || info.running))
      const stale = slot.stale === true
      const name = slot.name || slot.model || '未命名槽位'

      const begin = () => {
        setDraft({
          model: slot.model || '',
          name: slot.name || '',
          contextWindow: num(slot.contextWindow, 8192),
          idleSec: num(slot.idleSec, 180),
          think: slot.think !== false,
        })
        setEditing(true)
        setFlash(null)
      }

      const toggle = async () => {
        const next = !enabled
        setEnabled(next)
        setFlash(null)
        setBusy(true)
        try { await onSave({ enabled: next }) }
        catch (e) { setEnabled(!next); setFlash({ kind: 'err', text: '保存失败：' + errText(e) }) }
        finally { setBusy(false) }
      }

      const save = async () => {
        if (!draft) return
        const patch = {
          model: draft.model,
          name: (draft.name || '').trim() || draft.model,
          contextWindow: num(draft.contextWindow, 8192),
          idleSec: num(draft.idleSec, 180),
          think: !!draft.think,
        }
        setBusy(true)
        setFlash({ kind: 'ok', text: '正在保存…' })
        try {
          await onSave(patch)
          setEditing(false)
          setFlash({ kind: 'ok', text: '已保存，模型选择器已同步' })
        } catch (e) {
          setFlash({ kind: 'err', text: '保存失败：' + errText(e) })
        } finally { setBusy(false) }
      }

      const toggleLoad = async () => {
        setBusy(true)
        setFlash({ kind: 'ok', text: ready ? '正在熄火…' : '正在点火…' })
        try {
          if (ready) await onEvict(slot.id)
          else await onWarm(slot.id)
          setFlash({ kind: 'ok', text: ready ? '已熄火，进程已回收' : '已点火' })
        } catch (e) {
          setFlash({ kind: 'err', text: (ready ? '熄火失败：' : '点火失败：') + errText(e) })
        } finally { setBusy(false) }
      }

      const remove = async () => {
        setBusy(true)
        try { await onDelete(slot.id); setConfirm(false) }
        catch (e) { setFlash({ kind: 'err', text: '删除失败：' + errText(e) }); setConfirm(false) }
        finally { setBusy(false) }
      }

      const row = h('div', { className: 'dnp-slot', 'data-dnp': 'slot-row-' + slot.id },
        h('div', { className: 'dnp-cell model' },
          h('div', { className: 'n' },
            name,
            slot.llm === false ? h(Tag, { tone: 'mute' }, '不参与对话') : null,
            slot.embed ? h(Tag, null, 'embedding') : null,
            slot.think !== false ? h(Tag, { tone: 'mute' }, '思考链') : null,
            stale ? h(Tag, { tone: 'warn' }, '模型缺失') : null),
          h('div', { className: 'm' }, slot.model || '—'),
          stale
            ? h('div', { className: 'dnp-inline' },
                h('span', { className: 'dnp-label' }, '该模型不在当前后端清单里'),
                h(Btn, { small: true, disabled: blocked, onClick: begin, testid: 'slot-reselect-' + slot.id }, '点这里重选'))
            : null),
        h('div', { className: 'dnp-cell', 'data-label': '后端' }, label),
        h('div', { className: 'dnp-cell num', 'data-label': '上下文' }, num(slot.contextWindow, 0) ? String(num(slot.contextWindow, 0)) : '—'),
        h('div', { className: 'dnp-cell num', 'data-label': '空闲' }, fmtIdle(slot.idleSec)),
        h('div', { className: 'dnp-cell sw', 'data-label': '启用' },
          h(Switch, {
            on: enabled, disabled: blocked, onChange: toggle,
            label: '启用槽位 ' + name, testid: 'slot-switch-' + slot.id,
          })),
        h('div', { className: 'dnp-cell load', 'data-label': '加载状态' },
          running ? h(Tag, { tone: 'ok' }, '已加载') : h(Tag, { tone: 'mute' }, '未加载'),
          info && info.port ? h('span', { className: 'dnp-code' }, ':' + info.port) : null,
          h(Btn, {
            small: true, disabled: blocked, onClick: toggleLoad,
            testid: 'slot-load-' + slot.id,
            title: ready ? '回收该槽位的模型进程' : '一键点着该槽位的模型进程',
          }, ready ? '熄火' : '点火')),
        h('div', { className: 'dnp-cell act', 'data-label': '操作' },
          h(Btn, {
            small: true, disabled: blocked,
            onClick: () => { if (editing) { setEditing(false); setFlash(null) } else begin() },
            testid: 'slot-edit-' + slot.id,
          }, editing ? '取消' : '编辑'),
          h(Btn, {
            tone: 'danger', small: true, disabled: blocked,
            onClick: () => setConfirm(true), testid: 'slot-delete-' + slot.id,
          }, '删除')))

      const opts = choices.slice()
      if (draft && draft.model && !opts.some((c) => c.value === draft.model)) {
        opts.unshift({ value: draft.model, label: draft.model + '（已不在该后端）' })
      }

      const editor = editing && draft
        ? h('div', { className: 'dnp-editor', 'data-dnp': 'slot-editor-' + slot.id },
            h('div', { className: 'dnp-field' },
              h('label', { htmlFor: 'dnp-m-' + slot.id }, '模型'),
              h('select', {
                id: 'dnp-m-' + slot.id, className: 'dnp-select', value: draft.model,
                disabled: busy, style: { width: 220, maxWidth: '100%' },
                onChange: (e) => setDraft({ ...draft, model: e.target.value }),
              }, opts.map((c) => h('option', { key: c.value, value: c.value }, c.label)))),
            h('div', { className: 'dnp-field' },
              h('label', { htmlFor: 'dnp-n-' + slot.id }, '名称'),
              h('input', {
                id: 'dnp-n-' + slot.id, className: 'dnp-input narrow', value: draft.name, disabled: busy,
                placeholder: draft.model,
                onChange: (e) => setDraft({ ...draft, name: e.target.value }),
              })),
            h('div', { className: 'dnp-field' },
              h('label', { htmlFor: 'dnp-c-' + slot.id }, '上下文'),
              h('input', {
                id: 'dnp-c-' + slot.id, className: 'dnp-input mini', value: String(draft.contextWindow),
                disabled: busy, inputMode: 'numeric',
                onChange: (e) => setDraft({ ...draft, contextWindow: Number(String(e.target.value).replace(/[^0-9]/g, '')) || 0 }),
              })),
            h('div', { className: 'dnp-field' },
              h('label', { htmlFor: 'dnp-i-' + slot.id }, '空闲回收'),
              h('select', {
                id: 'dnp-i-' + slot.id, className: 'dnp-select', value: String(draft.idleSec), disabled: busy,
                onChange: (e) => setDraft({ ...draft, idleSec: Number(e.target.value) }),
              }, [60, 180, 600, 1800, 0].map((v) => h('option', { key: v, value: String(v) }, v ? v + ' 秒' : '不回收')))),
            h('div', { className: 'dnp-field' },
              h('label', null, '思考链'),
              h('span', { style: { height: 30, display: 'flex', alignItems: 'center' } },
                h(Switch, {
                  on: draft.think, disabled: busy,
                  onChange: (v) => setDraft({ ...draft, think: v }),
                  label: '思考链 ' + name, testid: 'slot-think-' + slot.id,
                }))),
            h('div', { className: 'dnp-editor-actions' },
              h('div', { style: { flex: '1 1 160px', minWidth: 0 } }, h(Note, { f: flash })),
              h(Btn, { small: true, disabled: busy, onClick: () => { setEditing(false); setFlash(null) } }, '取消'),
              h(Btn, { tone: 'primary', small: true, disabled: busy, onClick: save, testid: 'slot-save-' + slot.id }, busy ? '保存中…' : '保存')))
        : null

      const flashBand = !editing && flash
        ? h('div', { style: { padding: '0 14px 10px', borderTop: '1px solid var(--hr)' } }, h(Note, { f: flash }))
        : null

      const confirmBand = confirm
        ? h('div', { className: 'dnp-confirm', role: 'alertdialog', 'aria-label': '确认删除槽位' },
            h('div', { className: 'q' }, '删除槽位「' + name + '」？只改配置，不删磁盘上的模型文件。'),
            h('div', { className: 'dnp-confirm-actions' },
              h(Btn, { small: true, disabled: busy, onClick: () => setConfirm(false) }, '取消'),
              h(Btn, {
                tone: 'danger-solid', small: true, disabled: busy, onClick: remove,
                testid: 'slot-delete-confirm-' + slot.id,
              }, busy ? '删除中…' : '确认删除')))
        : null

      return h(React.Fragment, null, row, editor, flashBand, confirmBand)
    }

    /* ────────────────────────── 诊断包 / 剪贴板 ────────────────────────── */

    function buildDiagBundle({ s, d, logLines, bench }) {
      const cfg = cfgOf(s)
      const lines = []
      const push = (k, v) => lines.push(k + ': ' + (v === undefined || v === null || v === '' ? '—' : v))
      lines.push('=== dsh-npu 诊断包 ===')
      push('生成时间', new Date().toISOString())
      push('插件版本', (s && s.version) || (d && d.pluginVersion))
      push('代理端口', (s && s.runningPort) || cfg.frontPort)
      if (d && d.ports) push('端口详情', JSON.stringify(d.ports))
      push('绑定', (cfg.bindHost || '127.0.0.1') + ':' + (cfg.frontPort || ''))
      push('配置文件', (d && d.configFile) || cfg.configFile)
      push('数据根', (d && d.dataRoot) || cfg.dataRoot)
      push('日志文件', (d && d.logFile) || '')
      if (d && Array.isArray(d.pids)) push('PID', d.pids.join(', '))
      if (!d && s && s.status && Array.isArray(s.status.slots)) {
        const pids = s.status.slots.filter((x) => x && x.pid).map((x) => x.id + ':' + x.pid)
        push('槽位 PID', pids.join(', '))
      }
      push('模式', cfg.mode || 'auto')
      const bx = backendsOf(s)
      push('当前后端', (bx.chosen && (bx.chosen.label || bx.chosen.id)) || '—')
      push('健康自检', healthOf(s).map((x) => (x.state || '?') + ' ' + (x.label || x.id) + (x.detail ? '(' + x.detail + ')' : '')).join(' | '))
      push('槽位', slotsOf(s).map((x) => [x.id, x.backend || '?', x.model, x.enabled === false ? 'off' : 'on'].join('/')).join(' | '))
      if (bench && Array.isArray(bench.rows)) {
        push('混合基准', bench.rows.map((r) => r.engine + ' ' + r.tokps + ' tok/s').join(' | '))
      }
      lines.push('')
      lines.push('=== 日志（末 ' + logLines.length + ' 行） ===')
      for (const l of logLines) lines.push(String(l))
      return lines.join('\n')
    }

    function legacyCopy(text) {
      try {
        const ta = document.createElement('textarea')
        ta.value = text
        ta.setAttribute('readonly', '')
        ta.style.position = 'fixed'
        ta.style.left = '-9999px'
        ta.style.top = '0'
        document.body.appendChild(ta)
        ta.select()
        const ok = document.execCommand && document.execCommand('copy')
        document.body.removeChild(ta)
        return !!ok
      } catch { return false }
    }

    function readTheme() {
      try {
        const v = localStorage.getItem(THEME_KEY)
        return v === 'dark' || v === 'light' ? v : 'auto'
      } catch { return 'auto' }
    }

    /* ────────────────────────── 面板主体 ────────────────────────── */

    function PanelBody() {
      const [tab, setTab] = useState('overview')
      const tabRef = useRef('overview')
      const [s, setS] = useState(null)
      const [modelsDetail, setModelsDetail] = useState(null)
      const [logs, setLogs] = useState([])
      const [logFile, setLogFile] = useState('')
      const [diag, setDiag] = useState(null)
      const [bootErr, setBootErr] = useState('')
      const [loading, setLoading] = useState(true)
      const [pending, setPending] = useState({})
      const [flash, setFlash] = useState({})
      const [bench, setBench] = useState(null)
      const [dlSrc, setDlSrc] = useState('')
      const [theme, setTheme] = useState(() => readTheme())
      const [draft, setDraft] = useState(null)
      const [dirty, setDirty] = useState({ env: false, svc: false, hy: false })
      const [slotsFlash, setSlotsFlash] = useState(null)
      const [warnings, setWarnings] = useState([])

      const selectTab = useCallback((id) => {
        tabRef.current = id
        setTab(id)
      }, [])

      const isPending = (key) => !!pending[key]
      const note = (key, text) => setFlash((f) => ({ ...f, [key]: { kind: 'ok', text } }))
      const fail = (key, text) => setFlash((f) => ({ ...f, [key]: { kind: 'err', text } }))
      const clearFlash = (key) => setFlash((f) => { const n = { ...f }; delete n[key]; return n })

      const run = useCallback(async (key, fn) => {
        setPending((p) => ({ ...p, [key]: true }))
        try { return await fn() } finally {
          setPending((p) => { const n = { ...p }; delete n[key]; return n })
        }
      }, [])

      const reload = useCallback(async () => {
        const st = await api('state')
        setS(st)
        setBootErr('')
        if (st && Array.isArray(st.configWarnings)) setWarnings(st.configWarnings)
        return st
      }, [])
      const reloadQuiet = useCallback(async () => {
        try { await reload() } catch { /* 下一轮轮询会重试 */ }
      }, [reload])

      /* 主题：跟随系统（默认）；显式写入 html[data-dnp-theme] 覆盖 */
      useEffect(() => {
        try {
          const el = typeof document !== 'undefined' ? document.documentElement : null
          if (!el) return
          if (theme === 'dark' || theme === 'light') el.setAttribute('data-dnp-theme', theme)
          else el.removeAttribute('data-dnp-theme')
          try { localStorage.setItem(THEME_KEY, theme) } catch { /* 隐私模式 */ }
        } catch { /* 忽略 */ }
      }, [theme])

      /* 轮询：3 秒一次；页签隐藏时暂停（visibilitychange 恢复后立刻拉一次） */
      useEffect(() => {
        let alive = true
        let inflight = false
        async function tick() {
          if (!alive || inflight) return
          if (typeof document !== 'undefined' && document.hidden) return
          inflight = true
          try {
            const st = await api('state')
            if (!alive) return
            setS(st)
            setBootErr('')
            if (st && Array.isArray(st.configWarnings)) setWarnings(st.configWarnings)
            const current = tabRef.current
            if (current === 'overview') {
              try {
                const lg = await api('logs?tail=5')
                if (alive && Array.isArray(lg.lines)) {
                  setLogs(lg.lines)
                  if (lg.file) setLogFile(lg.file)
                }
              } catch { /* 日志不可用不阻塞面板 */ }
            } else {
              try {
                const md = await api('models')
                if (alive && md && (Array.isArray(md.flm) || Array.isArray(md.gguf))) setModelsDetail(md)
              } catch { /* 模型清单不可用不阻塞面板 */ }
            }
          } catch (e) {
            if (alive) setBootErr(errText(e))
          } finally {
            inflight = false
            if (alive) setLoading(false)
          }
        }
        tick()
        const timer = setInterval(tick, POLL_MS)
        const onVisible = () => { if (typeof document !== 'undefined' && !document.hidden) tick() }
        if (typeof document !== 'undefined') document.addEventListener('visibilitychange', onVisible)
        return () => {
          alive = false
          clearInterval(timer)
          if (typeof document !== 'undefined') document.removeEventListener('visibilitychange', onVisible)
        }
      }, [])

      /* 设置页草稿：未被用户改动的分区随服务端刷新，改过的保留 */
      useEffect(() => {
        if (!s) return
        const c = cfgOf(s)
        const hy = hybridOf(s)
        setDraft((d) => {
          const base = d || { env: {}, svc: {}, hy: {} }
          const next = { ...base }
          if (!dirty.env) next.env = { exePath: c.exePath || '', dataRoot: c.dataRoot || '', displayName: c.displayName || '' }
          if (!dirty.svc) {
            next.svc = {
              bindHost: c.bindHost || '127.0.0.1',
              frontPort: String(c.frontPort || 52630),
              tokenOn: !!c.hasApiToken,
              apiToken: '',
            }
          }
          if (!dirty.hy) {
            next.hy = {
              enabled: hy.enabled,
              mode: hy.mode,
              draftModel: hy.draftModel,
              verifyModel: hy.verifyModel,
              shortQueryTokens: hy.shortQueryTokens,
              raceTimeoutMs: hy.raceTimeoutMs,
            }
          }
          return next
        })
      }, [s, dirty.env, dirty.svc, dirty.hy])

      const setField = useCallback((section, key, value) => {
        setDraft((d) => {
          const base = d || { env: {}, svc: {}, hy: {} }
          return { ...base, [section]: { ...(base[section] || {}), [key]: value } }
        })
        setDirty((x) => (x[section] ? x : { ...x, [section]: true }))
      }, [])

      const postConfig = useCallback(async (patch) => {
        const r = await api('config', { body: patchBody(patch) })
        if (r && Array.isArray(r.warnings) && r.warnings.length) setWarnings(r.warnings)
        await reloadQuiet()
        return r || {}
      }, [reloadQuiet])

      /* ────────── 动作：概览 ────────── */

      const ignite = () => run('ignite', async () => {
        clearFlash('ignite')
        const targets = slotsOf(s).filter((x) => x.enabled !== false)
        if (!targets.length) {
          fail('ignite', '没有启用的槽位：先去「模型」页启用一个槽位')
          return
        }
        for (let i = 0; i < targets.length; i += 1) {
          const t = targets[i]
          note('ignite', '正在点火 ' + (i + 1) + '/' + targets.length + '：' + (t.name || t.model || t.id) + '…')
          try {
            await api('slot/warm', { body: { id: t.id } })
          } catch (e) {
            await reloadQuiet()
            fail('ignite', '点火失败（' + (t.name || t.id) + '）：' + errText(e))
            return
          }
        }
        await reloadQuiet()
        note('ignite', '已点火 ' + targets.length + ' 个槽位，守护进程在 DSH 的 Job Object 里')
      })

      const extinguish = () => run('ignite', async () => {
        clearFlash('ignite')
        note('ignite', '正在熄火…')
        try {
          await api('slot/evict', { body: {} })
          await reloadQuiet()
          note('ignite', '已熄火：模型进程全部回收，DSH 里不残留')
        } catch (e) { fail('ignite', '熄火失败：' + errText(e)) }
      })

      const healthFix = (item) => run('health:' + item.id, async () => {
        clearFlash('health')
        const fx = item.fix
        const suffix = typeof fx === 'string' ? fx : (fx && fx.suffix)
        if (!suffix) { fail('health', '这一项没有提供修复动作'); return }
        const body = (typeof fx === 'object' && fx && fx.body) || {}
        note('health', '正在修复：' + (item.label || item.id) + '…')
        try {
          await api(suffix, { body })
          await reloadQuiet()
          note('health', '已修复：' + (item.label || item.id))
        } catch (e) { fail('health', '修复失败（' + (item.label || item.id) + '）：' + errText(e)) }
      })

      const healthFixAll = () => run('health-all', async () => {
        clearFlash('health')
        const items = healthOf(s).filter((x) => x && x.fix)
        if (!items.length) { note('health', '自检里没有可自动修复的项'); return }
        let ok = 0
        let bad = 0
        for (let i = 0; i < items.length; i += 1) {
          const it = items[i]
          const fx = it.fix
          const suffix = typeof fx === 'string' ? fx : (fx && fx.suffix)
          if (!suffix) continue
          note('health', '正在修复 ' + (i + 1) + '/' + items.length + '：' + (it.label || it.id) + '…')
          try {
            await api(suffix, { body: (typeof fx === 'object' && fx && fx.body) || {} })
            ok += 1
          } catch (e) {
            bad += 1
            fail('health', '修复失败（' + (it.label || it.id) + '）：' + errText(e))
          }
        }
        await reloadQuiet()
        if (!bad) note('health', '已修复 ' + ok + ' 项，自检结果已刷新')
      })

      /* ────────── 动作：模型页 ────────── */

      const saveSlot = useCallback(async (id, patch) => {
        const next = slotsOf(s).map((x) => (x.id === id ? { ...x, ...patch } : x))
        await postConfig({ slots: next })
        return true
      }, [postConfig, s])

      const deleteSlot = useCallback(async (id) => {
        const next = slotsOf(s).filter((x) => x.id !== id)
        await postConfig({ slots: next })
      }, [postConfig, s])

      const warmSlot = useCallback(async (id) => {
        await api('slot/warm', { body: { id } })
        await reloadQuiet()
      }, [reloadQuiet])

      const evictSlot = useCallback(async (id) => {
        await api('slot/evict', { body: { id } })
        await reloadQuiet()
      }, [reloadQuiet])

      const addSlot = () => run('slot-add', async () => {
        setSlotsFlash(null)
        const slots = slotsOf(s)
        const bx = backendsOf(s)
        const chosenId = (bx.chosen && bx.chosen.id) || 'flm'
        const md = modelsDetail || modelsOf(s)
        const flmIds = md.flm.map((x) => x.id || x.name).filter(Boolean)
        const ggufFiles = md.gguf.map((x) => x.file || x.name).filter(Boolean)
        const pool = chosenId === 'flm' ? flmIds : ggufFiles
        if (!pool.length) {
          setSlotsFlash({ kind: 'err', text: '当前后端还没有可用模型：先在下面模型库里下载，或去后端里换一个已就绪的框架' })
          return
        }
        const ids = new Set(slots.map((x) => x.id))
        let n = slots.length + 1
        while (ids.has('slot' + n)) n += 1
        const model = pool[0]
        const slot = {
          id: 'slot' + n,
          backend: chosenId,
          model,
          name: model,
          contextWindow: 8192,
          think: false,
          embed: false,
          alsoServes: [],
          idleSec: 180,
          enabled: true,
        }
        try {
          await postConfig({ slots: slots.concat([slot]) })
          setSlotsFlash({ kind: 'ok', text: '已添加槽位 ' + slot.id + '：' + model + '（可在行内改模型/上下文/空闲）' })
        } catch (e) { setSlotsFlash({ kind: 'err', text: '添加失败：' + errText(e) }) }
      })

      const chooseBackend = (id, label) => run('be:' + id, async () => {
        clearFlash('be:' + id)
        const snap = s ? clone(s) : null
        const bx = backendsOf(s)
        if (s) setS({ ...s, backends: { ...bx, chosen: { id, label } } })
        try {
          await api('backend', { body: { id } })
          await reloadQuiet()
          note('be:' + id, '已切到 ' + label)
        } catch (e) {
          if (snap) setS(snap)
          fail('be:' + id, '切换失败：' + errText(e))
        }
      })

      const downloadRuntime = (b) => run('dl:' + b.id, async () => {
        clearFlash('dl:' + b.id)
        note('dl:' + b.id, '正在下载 ' + (b.label || b.id) + '…（进度实时显示在本行）')
        try {
          const r = await api('runtime/download', { body: { id: b.id } })
          await reloadQuiet()
          note('dl:' + b.id, (b.label || b.id) + ' 已就绪' + (r && r.exe ? '：' + r.exe : ''))
        } catch (e) { fail('dl:' + b.id, '下载失败：' + errText(e)) }
      })

      const downloadModel = () => run('model-dl', async () => {
        clearFlash('model-dl')
        const source = String(dlSrc || '').trim()
        if (!source) { fail('model-dl', '要填来源：模型 id（如 qwen3.5:0.8b）或 owner/repo#文件名'); return }
        note('model-dl', '正在下载：' + source + '…')
        try {
          const r = await api('model/download', { body: { source } })
          await reloadQuiet()
          note('model-dl', '已下载：' + ((r && r.file) || source))
          setDlSrc('')
        } catch (e) { fail('model-dl', '下载失败：' + errText(e)) }
      })

      const setSlotModel = (backend, name) => run('ms:' + backend + ':' + name, async () => {
        clearFlash('lib')
        try {
          const r = await api('model/select', { body: { backend, name } })
          await reloadQuiet()
          note('lib', '已把 ' + name + ' 设为槽位' + (r && r.slot && r.slot.id ? '（' + r.slot.id + '）' : ''))
        } catch (e) { fail('lib', '设为槽位失败：' + errText(e)) }
      })

      const deleteModel = async (backend, name) => {
        await api('model/delete', { body: { backend, name } })
        await reloadQuiet()
        note('lib', '已把 ' + name + ' 移到回收站（可恢复）')
      }

      const setHybridEnabled = (on) => run('hy-toggle', async () => {
        clearFlash('hy-toggle')
        try {
          await api('hybrid/config', { body: patchBody({ enabled: on }) })
          await reloadQuiet()
          note('hy-toggle', on ? '已启用第五框架 amd-hybrid' : '已关闭混合推理：对外仍是同一个 provider，不影响单引擎')
        } catch (e) { fail('hy-toggle', '切换失败：' + errText(e)) }
      })

      /* ────────── 动作：设置页 ────────── */

      const saveEnv = () => run('env', async () => {
        clearFlash('env')
        const v = (draft && draft.env) || {}
        try {
          const r = await postConfig({
            exePath: String(v.exePath || '').trim(),
            dataRoot: String(v.dataRoot || '').trim(),
            displayName: String(v.displayName || '').trim(),
          })
          setDirty((d) => ({ ...d, env: false }))
          note('env', '运行环境已保存' + (r.restartRequired ? '（端口/绑定地址需重启 DSH 生效）' : ''))
        } catch (e) { fail('env', '保存失败：' + errText(e)) }
      })

      const detectFlm = () => run('flm', async () => {
        clearFlash('flm')
        note('flm', '正在自动查找 flm.exe（有界扫盘）…')
        try {
          const r = await api('flm/detect', { body: {} })
          const exe = (r && (r.exePath || r.exe)) || (r && r.config && r.config.exePath) || ''
          if (!exe) throw new Error('后端没有返回 exePath')
          setField('env', 'exePath', exe)
          note('flm', '找到 flm.exe：' + exe)
          await reloadQuiet()
        } catch (e) {
          const m = errText(e)
          fail('flm', '自动查找失败：' + m + (/404|not found|no route|未知|不支持/i.test(m) ? '（flm/detect 可能还没注册进契约 §3，可手动填绝对路径）' : ''))
        }
      })

      const saveService = () => run('svc', async () => {
        clearFlash('svc')
        const v = (draft && draft.svc) || {}
        const port = num(String(v.frontPort || '').replace(/[^0-9]/g, ''), 0)
        if (!port || port < 1 || port > 65535) { fail('svc', '端口必须是 1-65535 之间的整数'); return }
        const patch = { bindHost: String(v.bindHost || '127.0.0.1').trim(), frontPort: port }
        if (!v.tokenOn) patch.apiToken = ''
        else if (v.apiToken) patch.apiToken = String(v.apiToken)
        try {
          const r = await postConfig(patch)
          setDirty((d) => ({ ...d, svc: false }))
          note('svc', '服务设置已保存' + (r.restartRequired ? '（端口/绑定地址需重启 DSH 才真正生效）' : ''))
        } catch (e) { fail('svc', '保存失败：' + errText(e)) }
      })

      const saveHybrid = () => run('hy', async () => {
        clearFlash('hy')
        const v = (draft && draft.hy) || {}
        try {
          await api('hybrid/config', {
            body: patchBody({
              enabled: !!v.enabled,
              mode: v.mode || 'auto',
              draftModel: v.draftModel || '',
              verifyModel: v.verifyModel || '',
              shortQueryTokens: num(v.shortQueryTokens, 48),
              raceTimeoutMs: num(v.raceTimeoutMs, 12000),
            }),
          })
          await reloadQuiet()
          setDirty((d) => ({ ...d, hy: false }))
          note('hy', '混合推理设置已保存（新请求立即按新模式编排）')
        } catch (e) { fail('hy', '保存失败：' + errText(e)) }
      })

      const runBench = () => run('bench', async () => {
        clearFlash('bench')
        setBench(null)
        try {
          const r = await api('hybrid/bench', { body: { prompt: '用一句话解释什么是本地推理。', maxTokens: 128 } })
          setBench(r || null)
          note('bench', '基准完成：' + ((r && r.rows && r.rows.length) || 0) + ' 个引擎')
        } catch (e) { fail('bench', '基准失败：' + errText(e)) }
      })

      const checkUpdates = () => run('upd', async () => {
        clearFlash('upd')
        note('upd', '正在检查镜像仓库…')
        try {
          await api('updates/check', { body: {} })
          await reloadQuiet()
          note('upd', '已检查更新')
        } catch (e) { fail('upd', '检查失败：' + errText(e)) }
      })

      const installUpdate = (item) => run('up:' + item.id, async () => {
        clearFlash('up:' + item.id)
        note('up:' + item.id, '正在更新 ' + (item.label || item.id) + '…')
        try {
          const r = await api('update', { body: { id: item.id } })
          await reloadQuiet()
          note('up:' + item.id, (item.label || item.id) + ' 已更新到 ' + ((r && r.latest) || item.latest || '最新版'))
        } catch (e) { fail('up:' + item.id, '更新失败：' + errText(e)) }
      })

      const copyDiag = () => run('diag', async () => {
        clearFlash('diag')
        try {
          let d = diag
          try { d = await api('diagnostics'); setDiag(d) } catch { /* 用缓存 */ }
          let lines = []
          try {
            const l = await api('logs?tail=200')
            lines = Array.isArray(l.lines) ? l.lines : []
          } catch { /* 日志可能不可用 */ }
          const bundle = buildDiagBundle({ s, d, logLines: lines, bench })
          try { window.__dnpLastBundle = bundle } catch { /* 忽略 */ }
          let copied = false
          try {
            if (navigator.clipboard && navigator.clipboard.writeText) {
              await navigator.clipboard.writeText(bundle)
              copied = true
            }
          } catch { copied = false }
          if (!copied) copied = legacyCopy(bundle)
          note('diag', copied
            ? '诊断包已复制到剪贴板（' + bundle.length + ' 字符）'
            : '浏览器拒绝了剪贴板写入；诊断包已存到 window.__dnpLastBundle')
        } catch (e) { fail('diag', '生成诊断包失败：' + errText(e)) }
      })

      const openLog = () => run('log-open', async () => {
        clearFlash('log')
        try {
          const r = await api('logs/open', { body: {} })
          note('log', '已打开日志：' + ((r && r.file) || logFile || ''))
        } catch (e) { fail('log', '打开日志失败：' + errText(e)) }
      })

      /* ============================ 渲染 ============================ */

      const retry = () => {
        setLoading(true)
        setBootErr('')
        reload()
          .catch((e) => setBootErr(errText(e)))
          .then(() => setLoading(false), () => setLoading(false))
      }

      function renderBootError() {
        return h('div', { className: 'dnp-page' },
          h('div', { className: 'dnp-wrap' },
            h('div', { className: 'dnp-head' }, h('h1', { className: 'dnp-h1' }, '燧心 · 本地 NPU 推理')),
            h('div', { className: 'dnp-row', style: { marginTop: 12 } },
              h('div', { className: 'dnp-row-main' },
                h('div', { className: 'dnp-row-title' }, '面板读不到状态'),
                h('div', { className: 'dnp-row-desc' }, bootErr || '未知错误'),
                h('div', { className: 'dnp-hint', style: { marginTop: 6 } },
                  '后端还在重构中时先看这里：GET ' + ROUTE + '/state 未就绪，或 DSH 宿主还没加载插件。'))),
            h(Btn, { tone: 'primary', onClick: retry, testid: 'btn-retry', ariaLabel: '重试读取面板状态' }, '重试')))
      }

      function onTabKey(e, i) {
        const n = TABS.length
        let j = -1
        if (e.key === 'ArrowRight') j = (i + 1) % n
        else if (e.key === 'ArrowLeft') j = (i - 1 + n) % n
        else if (e.key === 'Home') j = 0
        else if (e.key === 'End') j = n - 1
        if (j < 0) return
        e.preventDefault()
        selectTab(TABS[j].id)
        const el = typeof document !== 'undefined' ? document.getElementById('dnp-tab-' + TABS[j].id) : null
        if (el && el.focus) el.focus()
      }

      if (!s) {
        if (bootErr) return renderBootError()
        return h('div', { className: 'dnp-page' },
          h('div', { className: 'dnp-wrap' },
            h('div', { className: 'dnp-hint', style: { padding: '18px 0' }, role: 'status' }, '加载中…')))
      }

      /* ────────── 派生数据 ────────── */
      const cfg = cfgOf(s)
      const bx = backendsOf(s)
      const health = healthOf(s)
      const hy = hybridOf(s)
      const md = modelsDetail || modelsOf(s)
      const upd = updatesOf(s)
      const st = s.status || {}
      const slots = slotsOf(s)
      const stSlots = statusSlotsOf(s)
      const backendList = bx.backends
      const chosen = bx.chosen
      const chosenId = chosen && chosen.id
      const runningPort = s.runningPort || st.front || cfg.frontPort || ''
      const readySlots = stSlots.filter((x) => x && x.ready)
      const anyRunning = readySlots.length > 0
      const statusById = {}
      for (const x of stSlots) if (x && x.id) statusById[x.id] = x
      const updateFor = (id) => (upd.items || []).find((it) => it && (it.id === id ||
        (String(id).indexOf('llamacpp') === 0 && it.id === 'llamacpp')))
      const flmBackend = backendList.find((b) => b && b.id === 'flm')
      const hwDevices = (bx.devices || []).map((d) => (d && (d.name || d.id)) || '').filter(Boolean)
      const hwText = (hwDevices.length ? hwDevices.join('、') : (flmBackend && flmBackend.device ? flmBackend.device : '未探测到设备'))
      const engineTiles = buildEngineTiles({ slots, stSlots, backendList, hy, cfg })
      const currentModel = readySlots.map((x) => x.name || x.model).filter(Boolean).join('、')

      /* ────────── 概览 ────────── */
      function renderOverview() {
        const fixable = health.filter((x) => x && x.fix)
        const fixableCount = fixable.length
        const failCount = health.filter((x) => x && x.state === 'fail').length
        return h('div', null,
          h(Sect, { title: '引擎', sub: '三点状态：NPU 火种 · GPU 火线 · 混合链路' },
            h('div', { className: 'dnp-engines' }, engineTiles.map((t) => h('div', {
              className: 'dnp-engine', key: t.id, 'data-dnp': 'engine-' + t.id,
            },
              h('div', { className: 'dnp-eng-name' }, h(Dot, { state: t.dot }), t.name),
              h('div', { className: 'dnp-eng-state', role: 'status' }, t.state),
              h('div', { className: 'dnp-eng-meta' }, t.meta || '—')))),
            h('div', { className: 'dnp-facts' },
              h('span', null, '当前模型 ', h('b', null, currentModel || '未加载')),
              h('span', null, '端口 ', h('b', { style: { fontFamily: 'var(--mono)' } }, String(runningPort || '—'))),
              h('span', null, '后端 ', h('b', null, (chosen && (chosen.label || chosen.id)) || '自动选择')),
              h('span', null, '硬件 ', h('b', null, hwText))),
            h('div', { className: 'dnp-action' },
              h('button', {
                type: 'button',
                className: cx('dnp-bigbtn', anyRunning && 'stop'),
                disabled: isPending('ignite'),
                'data-dnp': 'btn-ignite',
                'aria-busy': isPending('ignite') ? 'true' : 'false',
                onClick: anyRunning ? extinguish : ignite,
              }, isPending('ignite') ? '处理中…' : (anyRunning ? '熄火' : '一键点火')),
              h('div', { className: 'dnp-action-text' }, anyRunning
                ? ('已点火 ' + readySlots.length + ' 个槽位：空闲到点自动回收，DSH 退出时进程树一起清零')
                : '一键点着所有启用的槽位；点着之后 DSH 的模型选择器立刻可用'),
              h(Btn, { small: true, disabled: isPending('ignite'), onClick: () => reloadQuiet(), testid: 'btn-refresh' }, '刷新状态')),
            h(Note, { f: flash.ignite })),

          h(Sect, {
            title: '健康自检',
            sub: health.length
              ? (failCount ? failCount + ' 项需要修复 · 共 ' + health.length + ' 项' : '全部正常 · 共 ' + health.length + ' 项')
              : '拿不到自检结果',
            right: h(Btn, {
              small: true,
              tone: fixableCount ? 'primary' : undefined,
              disabled: isPending('health-all') || !fixableCount,
              onClick: healthFixAll,
              testid: 'btn-fix-all',
            }, isPending('health-all') ? '修复中…' : (fixableCount ? '一键修复 ' + fixableCount + ' 项' : '无需修复')),
          },
            health.length
              ? h('ul', { className: 'dnp-health', 'aria-label': '健康自检清单', 'data-dnp': 'health-list' },
                  health.map((it) => h('li', { key: it.id || it.label, 'data-dnp': 'health-' + (it.id || it.label) },
                    h('span', {
                      className: cx('dnp-ico', it.state),
                      'aria-hidden': 'true',
                    }, it.state === 'ok' ? '✓' : it.state === 'warn' ? '!' : '✕'),
                    h('div', { className: 'dnp-health-main' },
                      h('div', { className: 'dnp-health-label' },
                        it.label || it.id,
                        h('span', { className: 'dnp-label', style: { marginLeft: 8 } },
                          it.state === 'ok' ? '正常' : it.state === 'warn' ? '建议处理' : '需要修复')),
                      it.detail ? h('div', { className: 'dnp-health-detail' }, it.detail) : null),
                    it.fix
                      ? h(Btn, {
                          small: true,
                          disabled: isPending('health:' + it.id),
                          onClick: () => healthFix(it),
                          testid: 'health-fix-' + (it.id || it.label),
                        }, isPending('health:' + it.id) ? '修复中…' : ((it.fix && it.fix.label) || '修复'))
                      : h(Tag, { tone: 'mute' }, '无需操作'))))
              : h('div', { className: 'dnp-empty' }, '后端没有返回 health 项：自检暂不可用。'),
            h(Note, { f: flash.health })),

          h(Sect, {
            title: '最近日志',
            sub: logFile || '≥ 5 条环形缓冲',
            right: h(Btn, { small: true, disabled: isPending('log-open'), onClick: openLog, testid: 'btn-open-log' }, '打开日志'),
          },
            logs.length
              ? h('div', { className: 'dnp-logs', role: 'log', 'aria-label': '最近 5 条日志', 'data-dnp': 'logs' },
                  logs.slice(-5).map((line, i) => h('div', { className: 'dnp-log-line', key: i, title: String(line) }, String(line))))
              : h('div', { className: 'dnp-empty' }, '还没有日志：点火后这里显示运行时的最新 5 条记录。'),
            h(Note, { f: flash.log })),

          h('div', { className: 'dnp-sovereign' },
            h('span', { className: 'dnp-tag ok', style: { flex: 'none' } }, '断网可用'),
            h('div', null,
              h('b', null, '本地主权：'), '推理全在本机 NPU / GPU 上跑，请求不出网卡。断网、内网、飞机上都能答；数据不出机器，也不需要任何云端 key。')))
      }

      /* ────────── 模型 ────────── */
      function modelChoicesFor(backendId) {
        if (!backendId || backendId === 'flm') {
          return md.flm.map((m) => ({
            value: m.id || m.name,
            label: (m.id || m.name) + (m.ctx ? ' · ' + m.ctx : ''),
          }))
        }
        return md.gguf
          .filter((g) => !g.backend || g.backend === backendId)
          .map((g) => ({
            value: g.file || g.name,
            label: (g.file || g.name) + (g.sizeMB ? ' · ' + g.sizeMB + ' MB' : ''),
          }))
      }

      function renderBackendRow(id) {
        const b = backendList.find((x) => x && x.id === id) || {
          id, label: BACKEND_LABEL[id], installed: false, note: '', models: [],
        }
        const active = !!chosen && chosen.id === id
        const up = updateFor(id)
        const prog = b.download || b.progress || null
        const downloading = !!(prog && prog.state === 'running')
        const busy = isPending('be:' + id) || isPending('dl:' + id) || isPending('flm')
        return h('div', { className: 'dnp-row', key: 'be-' + id, 'data-dnp': 'backend-' + id },
          h('div', { className: 'dnp-row-main' },
            h('div', { className: 'dnp-row-title' }, b.label || BACKEND_LABEL[id] || id,
              active ? h(Tag, { tone: 'ok' }, '使用中') : null,
              b.installed
                ? h(Tag, { tone: b.external ? 'mute' : undefined }, b.external ? '外部安装' : '已安装')
                : h(Tag, { tone: 'mute' }, '未安装'),
              b.device ? h(Tag, { tone: 'mute' }, '设备 ' + b.device) : null,
              downloading ? h(Tag, { tone: 'warn' }, '下载中') : null,
              up && up.available ? h(Tag, { tone: 'warn' }, '可更新 ' + (up.latest || '')) : null),
            h('div', { className: 'dnp-row-desc' }, [
              b.note || '',
              num(b.sizeMB, 0) > 0 ? '约 ' + num(b.sizeMB, 0) + ' MB' : '',
              Array.isArray(b.models) && b.models.length ? b.models.length + ' 个模型' : '',
            ].filter(Boolean).join(' · ') || '—'),
            prog ? h(Progress, { p: prog }) : null,
            h(Note, { f: flash['dl:' + id] })),
          h('div', { className: 'dnp-row-ctl' },
            b.installed
              ? h(Switch, {
                  on: active,
                  disabled: busy,
                  onChange: () => { if (!active) chooseBackend(id, b.label || BACKEND_LABEL[id] || id) },
                  label: '选用后端 ' + (b.label || id),
                  testid: 'backend-switch-' + id,
                })
              : (id === 'flm'
                  ? h(Btn, {
                      small: true, disabled: busy,
                      onClick: () => selectTab('settings'),
                      testid: 'backend-flm-path',
                    }, '去填路径')
                  : h(Btn, {
                      small: true, disabled: busy,
                      onClick: () => downloadRuntime(b),
                      testid: 'backend-download-' + id,
                    }, isPending('dl:' + id) ? '下载中…' : '下载')),
            h(Note, { f: flash['be:' + id] })))
      }

      function renderHybridRow() {
        const enabled = !!hy.enabled
        const engText = (hy.engines || []).map((e) => {
          const name = e.id === 'npu' ? 'NPU' : e.id === 'gpu' ? 'GPU' : (e.id || '?')
          return name + (e.ready ? ' 就绪' : ' 待点火') + (e.model ? '（' + e.model + '）' : '')
        }).join(' · ')
        return h('div', { className: 'dnp-row', key: 'be-hybrid', 'data-dnp': 'backend-amd-hybrid' },
          h('div', { className: 'dnp-row-main' },
            h('div', { className: 'dnp-row-title' }, 'AMD 混合推理 · 第五框架',
              enabled ? h(Tag, { tone: 'ok' }, '已启用') : h(Tag, { tone: 'mute' }, '未启用'),
              h(Tag, null, '模式 ' + (hy.mode || 'auto'))),
            h('div', { className: 'dnp-row-desc' },
              (engText ? engText + ' · ' : '') + 'NPU 与 GPU 在同一 Job Object 下双引擎协同，对外仍是同一个 OpenAI 兼容端口。'),
            h(Note, { f: flash['hy-toggle'] })),
          h('div', { className: 'dnp-row-ctl' },
            h(Btn, { small: true, onClick: () => selectTab('settings'), testid: 'hybrid-goto-settings' }, '配置'),
            h(Switch, {
              on: enabled,
              disabled: isPending('hy-toggle'),
              onChange: setHybridEnabled,
              label: '启用第五框架 amd-hybrid',
              testid: 'hybrid-switch',
            })))
      }

      function renderModels() {
        const flmUsed = (id) => slots.some((x) => (x.backend || 'flm') === 'flm' && x.model === id)
        const ggufUsed = (file) => slots.some((x) => x.backend && x.backend !== 'flm' && x.model === file)
        return h('div', null,
          h(Sect, {
            title: '模型槽位',
            sub: '模型 / 后端 / 上下文 / 空闲 / 开关 / 加载状态 / 编辑 / 删除',
            right: h(Btn, {
              tone: 'primary', small: true,
              disabled: isPending('slot-add'),
              onClick: addSlot,
              testid: 'btn-add-slot',
            }, isPending('slot-add') ? '添加中…' : '添加槽位'),
          },
            slots.length
              ? h('div', { className: 'dnp-tbl', 'aria-label': '模型槽位表', 'data-dnp': 'slot-table' },
                  h('div', { className: 'dnp-tbl-head' },
                    h('span', null, '模型'),
                    h('span', null, '后端'),
                    h('span', null, '上下文'),
                    h('span', null, '空闲'),
                    h('span', null, '启用'),
                    h('span', null, '加载状态'),
                    h('span', { className: 'r' }, '操作')),
                  slots.map((slot) => h(SlotRow, {
                    key: slot.id,
                    slot,
                    info: statusById[slot.id] || stSlots.find((x) => x && x.model === slot.model) || null,
                    label: backendLabel(slot.backend, backendList),
                    choices: modelChoicesFor(slot.backend),
                    disabled: false,
                    onSave: (patch) => saveSlot(slot.id, patch),
                    onDelete: (id) => deleteSlot(id),
                    onWarm: warmSlot,
                    onEvict: evictSlot,
                  })))
              : h('div', { className: 'dnp-empty' }, '还没有槽位：点右上角「添加槽位」，或先在下面的模型库里下载一个模型。'),
            h(Note, { f: slotsFlash })),

          h(Sect, { title: '模型库', sub: 'FLM（NPU，按模型 id）与 GGUF（llama.cpp，按文件）分开管理' },
            h('div', { className: 'dnp-lib' },
              h('div', { className: 'dnp-lib-col' },
                h('div', { className: 'dnp-lib-head' }, 'FLM · NPU', h('span', { className: 'meta' }, md.flm.length + ' 个模型')),
                md.flm.length
                  ? md.flm.map((m) => {
                      const id = m.id || m.name
                      return h('div', { className: 'dnp-lib-item', key: 'flm-' + id, 'data-dnp': 'lib-flm-' + id },
                        h('div', { className: 'dnp-lib-main' },
                          h('div', { className: 'dnp-lib-name' }, id,
                            m.installed === false ? h(Tag, { tone: 'warn' }, '未安装') : null,
                            flmUsed(id) ? h(Tag, { tone: 'ok' }, '已有槽位') : null),
                          h('div', { className: 'dnp-lib-meta' },
                            [(m.ctx ? m.ctx + ' 上下文' : ''), (m.labels || []).join(' ')].filter(Boolean).join(' · ') || '—')),
                        h('div', { className: 'ctl' },
                          h(Btn, {
                            small: true,
                            disabled: isPending('ms:flm:' + id),
                            onClick: () => setSlotModel('flm', id),
                            testid: 'lib-use-flm-' + id,
                          }, '设为槽位'),
                          h(DangerAction, {
                            question: '删除 ' + id + '？',
                            disabled: isPending('ms:flm:' + id),
                            onConfirm: () => deleteModel('flm', id),
                            testid: 'lib-del-flm-' + id,
                          }, '删除')))
                    })
                  : h('div', { className: 'dnp-empty', style: { margin: 12 } }, 'FLM 模型目录是空的：把 FLM 路径指对，或用下面的来源下载。')),
              h('div', { className: 'dnp-lib-col' },
                h('div', { className: 'dnp-lib-head' }, 'GGUF · llama.cpp', h('span', { className: 'meta' }, md.gguf.length + ' 个文件')),
                md.gguf.length
                  ? md.gguf.map((g) => {
                      const file = g.file || g.name
                      const backend = g.backend && g.backend !== 'flm'
                        ? g.backend
                        : (chosenId && chosenId !== 'flm' ? chosenId : 'llamacpp-vulkan')
                      return h('div', { className: 'dnp-lib-item', key: 'gguf-' + file, 'data-dnp': 'lib-gguf-' + file },
                        h('div', { className: 'dnp-lib-main' },
                          h('div', { className: 'dnp-lib-name' }, file,
                            ggufUsed(file) ? h(Tag, { tone: 'ok' }, '已有槽位') : null),
                          h('div', { className: 'dnp-lib-meta' },
                            [
                              g.sizeMB ? g.sizeMB + ' MB' : (g.size ? fmtSize(g.size) : ''),
                              g.quant || '',
                              g.params || '',
                            ].filter(Boolean).join(' · ') || '—')),
                        h('div', { className: 'ctl' },
                          h(Btn, {
                            small: true,
                            disabled: isPending('ms:' + backend + ':' + file),
                            onClick: () => setSlotModel(backend, file),
                            testid: 'lib-use-gguf-' + file,
                          }, '设为槽位'),
                          h(DangerAction, {
                            question: '删除 ' + file + '？',
                            disabled: isPending('ms:' + backend + ':' + file),
                            onConfirm: () => deleteModel(backend, file),
                            testid: 'lib-del-gguf-' + file,
                          }, '删除')))
                    })
                  : h('div', { className: 'dnp-empty', style: { margin: 12 } }, 'mods 里还没有 .gguf：把模型文件放进目录，或用下面的来源下载。'))),
            h('div', { className: 'dnp-inline', style: { marginTop: 12 } },
              h('span', { className: 'dnp-label' }, '从来源下载'),
              h('input', {
                className: 'dnp-input mono', style: { flex: '1 1 200px' },
                placeholder: '模型 id 或 owner/repo#文件名.gguf',
                value: dlSrc, disabled: isPending('model-dl'),
                'aria-label': '模型下载来源',
                onChange: (e) => setDlSrc(e.target.value),
              }),
              h(Btn, {
                small: true,
                disabled: isPending('model-dl') || !String(dlSrc || '').trim(),
                onClick: downloadModel,
                testid: 'btn-model-download',
              }, isPending('model-dl') ? '下载中…' : '下载')),
            h(Note, { f: flash['model-dl'] }),
            h(Note, { f: flash.lib })),

          h(Sect, { title: '后端', sub: '四行框架 + 第五框架；开关 = 选中该后端（混合行 = 启用第五框架）' },
            h('div', { className: 'dnp-card' },
              BACKEND_ORDER.map((id) => renderBackendRow(id)),
              renderHybridRow()),
            h('div', { className: 'dnp-hint' }, '模型只出现在所属框架下面：FLM 读自己的目录，llama.cpp 读 mods 目录，互不混用。切换后端会自动挑一个可用模型。')))
      }

      /* ────────── 设置 ────────── */
      function renderSettings() {
        const env = (draft && draft.env) || {}
        const svc = (draft && draft.svc) || {}
        const hyv = (draft && draft.hy) || {}
        const di = diag || {}
        const flmOk = !!(flmBackend && flmBackend.installed)
        const modeName = (id) => (HYBRID_MODES.find((m) => m.id === id) || { name: id }).name
        const diagPortsText = () => {
          const p = di.ports || {}
          const parts = []
          if (has(p.front)) parts.push('front ' + p.front)
          if (has(p.configured)) parts.push('配置 ' + p.configured)
          if (has(p.actual)) parts.push('实际 ' + p.actual)
          if (!parts.length && runningPort) parts.push(String(runningPort))
          return parts.join(' · ') || '—'
        }
        const diagPidsText = () => {
          const pids = Array.isArray(di.pids) ? di.pids : []
          if (pids.length) {
            return pids.map((x) => (x && typeof x === 'object' ? ((x.id ? x.id + ':' : '') + (x.pid || '')) : String(x))).join(', ')
          }
          const fromStatus = stSlots.filter((x) => x && x.pid).map((x) => x.id + ':' + x.pid)
          return fromStatus.join(', ') || '—'
        }
        const benchRows = (bench && Array.isArray(bench.rows)) ? bench.rows : []
        const benchTable = benchRows.length
          ? h('div', null,
              h('table', { className: 'dnp-bench', 'data-dnp': 'bench-table' },
                h('thead', null, h('tr', null,
                  h('th', null, '引擎'),
                  h('th', { className: 'num' }, 'tok/s'),
                  h('th', { className: 'num' }, '首 token'),
                  h('th', { className: 'num' }, '总耗时'))),
                h('tbody', null, benchRows.map((r) => h('tr', { key: r.engine },
                  h('td', null, r.engine === 'npu' ? 'NPU 火种' : r.engine === 'gpu' ? 'GPU 火线' : '混合链路'),
                  h('td', { className: 'num' }, num(r.tokps, 0) ? num(r.tokps, 0).toFixed(1) : '—'),
                  h('td', { className: 'num' }, has(r.firstTokenMs) ? Math.round(num(r.firstTokenMs, 0)) + ' ms' : '—'),
                  h('td', { className: 'num' }, has(r.totalMs) ? Math.round(num(r.totalMs, 0)) + ' ms' : '—'))))),
              has(bench && bench.acceptRate)
                ? h('div', { className: 'dnp-hint', style: { marginTop: 6 } },
                    '草稿接受率 ' + (Math.round(num(bench.acceptRate, 0) * 1000) / 10) + '%')
                : null)
          : null

        return h('div', null,
          h(Sect, { title: '运行环境', sub: 'FLM 路径 / 数据根 / 显示名' },
            h('div', { className: 'dnp-card' },
              h(Row, {
                title: ['FLM 可执行文件', flmOk ? h(Tag, { tone: 'ok' }, '已找到') : h(Tag, { tone: 'warn' }, '未找到')],
                desc: cfg.exePath || '没找到 flm.exe：填绝对路径（含 flm.exe），或点「自动查找」有界扫盘',
                ctl: h('div', { className: 'dnp-inline', style: { marginTop: 0 } },
                  h('input', {
                    className: 'dnp-input mono wide',
                    value: env.exePath || '',
                    disabled: isPending('env') || isPending('flm'),
                    placeholder: 'D:\\dsh-npu-data\\frameworks\\flm-1.0.11\\flm.exe',
                    'aria-label': 'FLM 可执行文件路径',
                    onChange: (e) => setField('env', 'exePath', e.target.value),
                  }),
                  h(Btn, { small: true, disabled: isPending('flm'), onClick: detectFlm, testid: 'btn-detect-flm' },
                    isPending('flm') ? '查找中…' : '自动查找'))}),
              h(Row, {
                title: '数据根目录',
                desc: 'mods / runtimes / logs 所在；历史版本数据在外置盘时把它指回来',
                ctl: h('input', {
                  className: 'dnp-input mono wide',
                  value: env.dataRoot || '',
                  disabled: isPending('env'),
                  placeholder: 'D:\\dsh-npu-data',
                  'aria-label': '数据根目录',
                  onChange: (e) => setField('env', 'dataRoot', e.target.value),
                }),
              }),
              h(Row, {
                title: '显示名称',
                desc: '模型选择器里 npu-local 的显示名（留空 = 本机 NPU）',
                ctl: h('input', {
                  className: 'dnp-input', style: { width: 200 },
                  value: env.displayName || '',
                  disabled: isPending('env'),
                  placeholder: '燧心 · 本地推理',
                  'aria-label': '显示名称',
                  onChange: (e) => setField('env', 'displayName', e.target.value),
                }),
              }),
              h(Row, {
                title: '保存运行环境',
                desc: '保存后立即生效（端口 / 绑定地址除外）',
                ctl: h(Btn, { tone: 'primary', disabled: isPending('env'), onClick: saveEnv, testid: 'btn-save-env' },
                  isPending('env') ? '保存中…' : '保存'),
              })),
            h(Note, { f: flash.env }),
            h(Note, { f: flash.flm })),

          h(Sect, { title: '服务', sub: '端口 / 绑定 / API token' },
            h('div', { className: 'dnp-card' },
              h(Row, {
                title: '绑定地址',
                desc: '127.0.0.1 = 只有本机能用；0.0.0.0 = 局域网可调用（建议同时打开 token）',
                ctl: h('select', {
                  className: 'dnp-select',
                  value: svc.bindHost || '127.0.0.1',
                  disabled: isPending('svc'),
                  'aria-label': '绑定地址',
                  onChange: (e) => setField('svc', 'bindHost', e.target.value),
                }, [
                  ['127.0.0.1', '127.0.0.1（仅本机）'],
                  ['0.0.0.0', '0.0.0.0（所有网卡）'],
                ].map(([v, l]) => h('option', { key: v, value: v }, l))),
              }),
              h(Row, {
                title: '代理端口',
                desc: 'OpenAI 兼容端口，默认 52630；改动需重启 DSH',
                ctl: h('input', {
                  className: 'dnp-input mini',
                  value: svc.frontPort || '',
                  disabled: isPending('svc'),
                  inputMode: 'numeric',
                  'aria-label': '代理端口',
                  onChange: (e) => setField('svc', 'frontPort', String(e.target.value).replace(/[^0-9]/g, '')),
                }),
              }),
              h(Row, {
                title: 'API token',
                desc: svc.tokenOn
                  ? '局域网请求需带 Authorization: Bearer <token>；本机来源永远免 token'
                  : '默认关闭：局域网内任何人都能调用',
                ctl: h(Switch, {
                  on: !!svc.tokenOn,
                  disabled: isPending('svc'),
                  onChange: (v) => setField('svc', 'tokenOn', v),
                  label: '要求 API token',
                  testid: 'svc-token',
                }),
              }),
              svc.tokenOn
                ? h(Row, {
                    title: 'token 内容',
                    desc: cfg.hasApiToken ? '已设置；留空表示不修改' : '还没有设置',
                    ctl: h('input', {
                      className: 'dnp-input', style: { width: 220 }, type: 'password',
                      value: svc.apiToken || '',
                      disabled: isPending('svc'),
                      placeholder: '粘贴一个 token',
                      'aria-label': 'API token 内容',
                      onChange: (e) => setField('svc', 'apiToken', e.target.value),
                    }),
                  })
                : null,
              h(Row, {
                title: '保存服务设置',
                desc: '端口 / 绑定地址改动需要重启 DSH 才真正生效',
                ctl: h(Btn, { tone: 'primary', disabled: isPending('svc'), onClick: saveService, testid: 'btn-save-svc' },
                  isPending('svc') ? '保存中…' : '保存'),
              })),
            h(Note, { f: flash.svc })),

          h(Sect, {
            title: '混合推理',
            sub: '第五框架 amd-hybrid：NPU + GPU 双引擎协同，对外一个端口',
            right: h(Btn, {
              small: true, tone: 'primary',
              disabled: isPending('bench'),
              onClick: runBench,
              testid: 'btn-bench',
            }, isPending('bench') ? '跑基准中…' : '跑基准'),
          },
            h('div', { className: 'dnp-card' },
              h(Row, {
                title: ['启用混合推理', hy.enabled ? h(Tag, { tone: 'ok' }, '已启用') : h(Tag, { tone: 'mute' }, '已关闭')],
                desc: '开着也是一个 provider、一个端口；关掉则单引擎照常工作',
                ctl: h(Switch, {
                  on: !!hyv.enabled,
                  disabled: isPending('hy') || isPending('hy-toggle'),
                  onChange: (v) => setField('hy', 'enabled', v),
                  label: '启用混合推理',
                  testid: 'hy-enable',
                }),
              })),
            h('div', { style: { padding: '10px 0 2px' } },
              h('div', { className: 'dnp-label', style: { marginBottom: 2 } }, '编排模式'),
              h('div', { className: 'dnp-tiles', role: 'group', 'aria-label': '混合推理编排模式' },
                HYBRID_MODES.map((m) => h('button', {
                  key: m.id, type: 'button', className: 'dnp-tile',
                  'aria-pressed': (hyv.mode || 'auto') === m.id ? 'true' : 'false',
                  disabled: isPending('hy'),
                  'data-dnp': 'mode-' + m.id,
                  onClick: () => setField('hy', 'mode', m.id),
                }, h('div', { className: 'dnp-tile-name' }, m.name),
                  h('div', { className: 'dnp-tile-desc' }, m.desc)))),
              h('div', { className: 'dnp-hint', style: { marginTop: 6 } },
                '当前生效：' + modeName(hy.mode) + ' · ' +
                (hy.enabled ? '已启用' : '未启用，保存后生效') +
                (hy.last && hy.last.engine ? ' · 上次 ' + hy.last.engine + (hy.last.ms ? ' ' + Math.round(hy.last.ms) + ' ms' : '') : ''))),
            h('div', { className: 'dnp-card' },
              h(Row, {
                title: '草稿模型（NPU 侧）',
                desc: 'cascade / augment 时先让它在 NPU 上跑（FLM 模型 id）',
                ctl: h('select', {
                  className: 'dnp-select', style: { maxWidth: 280 },
                  value: hyv.draftModel || '',
                  disabled: isPending('hy'),
                  'aria-label': '草稿模型',
                  onChange: (e) => setField('hy', 'draftModel', e.target.value),
                }, [h('option', { key: '', value: '' }, '（未选）')].concat(
                  md.flm.map((m) => h('option', { key: m.id || m.name, value: m.id || m.name }, m.id || m.name)))),
              }),
              h(Row, {
                title: '验证模型（GPU 侧）',
                desc: 'race / cascade 升级时由它在 GPU 上重答（gguf 文件名）',
                ctl: h('select', {
                  className: 'dnp-select', style: { maxWidth: 280 },
                  value: hyv.verifyModel || '',
                  disabled: isPending('hy'),
                  'aria-label': '验证模型',
                  onChange: (e) => setField('hy', 'verifyModel', e.target.value),
                }, [h('option', { key: '', value: '' }, '（未选）')].concat(
                  md.gguf.map((g) => h('option', { key: g.file || g.name, value: g.file || g.name }, g.file || g.name)))),
              }),
              h(Row, {
                title: '短问题阈值 / 竞速超时',
                desc: 'cascade：≤ 该 token 数先走 NPU；race：超过超时即让另一引擎接手',
                ctl: h('div', { className: 'dnp-inline', style: { marginTop: 0 } },
                  h('input', {
                    className: 'dnp-input mini', inputMode: 'numeric',
                    value: String(hyv.shortQueryTokens === undefined || hyv.shortQueryTokens === null ? 48 : hyv.shortQueryTokens),
                    disabled: isPending('hy'),
                    'aria-label': '短问题阈值（tokens）',
                    onChange: (e) => setField('hy', 'shortQueryTokens', Number(String(e.target.value).replace(/[^0-9]/g, '')) || 0),
                  }),
                  h('span', { className: 'dnp-label' }, 'tokens'),
                  h('input', {
                    className: 'dnp-input mini', inputMode: 'numeric',
                    value: String(hyv.raceTimeoutMs === undefined || hyv.raceTimeoutMs === null ? 12000 : hyv.raceTimeoutMs),
                    disabled: isPending('hy'),
                    'aria-label': '竞速超时（毫秒）',
                    onChange: (e) => setField('hy', 'raceTimeoutMs', Number(String(e.target.value).replace(/[^0-9]/g, '')) || 0),
                  }),
                  h('span', { className: 'dnp-label' }, 'ms')),
              }),
              h(Row, {
                title: '保存混合推理设置',
                desc: '保存后新请求立即按新模式编排（引擎生命周期跟着 DSH）',
                ctl: h(Btn, { tone: 'primary', disabled: isPending('hy'), onClick: saveHybrid, testid: 'btn-save-hy' },
                  isPending('hy') ? '保存中…' : '保存'),
              })),
            h(Note, { f: flash.hy }),
            h(Note, { f: flash.bench }),
            benchTable,
            !benchRows.length
              ? h('div', { className: 'dnp-hint', style: { marginTop: 8 } },
                  '点右上角「跑基准」：同一 prompt 分别跑 NPU / GPU / 混合，得到 tok/s、首 token 与总耗时。')
              : null,
            h(Note, { f: flash['hy-toggle'] })),

          h(Sect, {
            title: '框架更新',
            sub: upd.checkedAt ? '上次检查 ' + fmtStamp(upd.checkedAt) : '还没检查过',
            right: h(Btn, {
              small: true,
              disabled: isPending('upd') || !!upd.checking,
              onClick: checkUpdates,
              testid: 'btn-check-updates',
            }, isPending('upd') || upd.checking ? '检查中…' : '检查更新'),
          },
            h('div', { className: 'dnp-card' },
              upd.items.length
                ? upd.items.map((it) => {
                    const prog = upd.progress && upd.progress.id === it.id ? upd.progress : null
                    return h('div', { className: 'dnp-row', key: 'upd-' + it.id, 'data-dnp': 'update-' + it.id },
                      h('div', { className: 'dnp-row-main' },
                        h('div', { className: 'dnp-row-title' }, it.label || it.id,
                          it.available
                            ? h(Tag, { tone: 'warn' }, '可更新')
                            : (it.checked === false ? h(Tag, { tone: 'mute' }, '无法检查') : h(Tag, { tone: 'ok' }, '已是最新'))),
                        h('div', { className: 'dnp-row-desc' },
                          '当前 ' + (it.current || '未知') +
                          (it.latest ? ' · 最新 ' + it.latest : '') +
                          (it.note ? ' · ' + it.note : '')),
                        prog ? h(Progress, { p: prog }) : null,
                        h(Note, { f: flash['up:' + it.id] })),
                      h('div', { className: 'dnp-row-ctl' },
                        it.available
                          ? h(Btn, {
                              tone: 'primary', small: true,
                              disabled: isPending('up:' + it.id),
                              onClick: () => installUpdate(it),
                              testid: 'update-btn-' + it.id,
                            }, isPending('up:' + it.id) ? '更新中…' : '更新')
                          : null))
                  })
                : h('div', { className: 'dnp-row' },
                    h('div', { className: 'dnp-row-main' },
                      h('div', { className: 'dnp-empty' }, '还没有检查结果：点右上角「检查更新」。')))),
            (upd.errors || []).length
              ? h('div', { className: 'dnp-hint' }, '检查错误：' + upd.errors.map((e) => (typeof e === 'string' ? e : (e && e.message) || '')).join('；'))
              : null,
            h(Note, { f: flash.upd })),

          h(Sect, {
            title: '诊断',
            sub: '配置 / 日志 / 端口 / PID',
            right: h('div', { className: 'dnp-h2-right' },
              h(Btn, { small: true, disabled: isPending('diag'), onClick: copyDiag, testid: 'btn-copy-diag' },
                isPending('diag') ? '打包中…' : '复制诊断包'),
              h(Btn, { small: true, disabled: isPending('log-open'), onClick: openLog, testid: 'btn-open-log-2' }, '打开日志')),
          },
            h('div', { className: 'dnp-card' },
              h(Row, { title: '插件版本', desc: h('span', { className: 'dnp-code' }, String(s.version || di.pluginVersion || '—')) }),
              h(Row, { title: '配置文件', desc: h('span', { className: 'dnp-code' }, String(di.configFile || cfg.configFile || '—')) }),
              h(Row, { title: '数据根', desc: h('span', { className: 'dnp-code' }, String(di.dataRoot || cfg.dataRoot || '—')) }),
              h(Row, { title: '日志文件', desc: h('span', { className: 'dnp-code' }, String(di.logFile || logFile || '—')) }),
              h(Row, { title: '端口', desc: h('span', { className: 'dnp-code' }, diagPortsText()) }),
              h(Row, { title: 'PID', desc: h('span', { className: 'dnp-code' }, diagPidsText()) })),
            h(Note, { f: flash.diag }),
            h(Note, { f: flash.log })),

          h(Sect, { title: '外观', sub: '深浅色跟随系统；下面三档可强制覆盖（html[data-dnp-theme]）' },
            h('div', { className: 'dnp-tiles', style: { gridTemplateColumns: 'repeat(3, minmax(0, 1fr))' } },
              [
                ['auto', '跟随系统', '默认'],
                ['dark', '深色', '覆盖'],
                ['light', '浅色', '覆盖'],
              ].map(([id, name, noteText]) => h('button', {
                key: id, type: 'button', className: 'dnp-tile',
                'aria-pressed': theme === id ? 'true' : 'false',
                'data-dnp': 'theme-' + id,
                onClick: () => setTheme(id),
              }, h('div', { className: 'dnp-tile-name' }, name), h('div', { className: 'dnp-tile-desc' }, noteText))))),

          warnings.length
            ? h('div', { className: 'dnp-warnbox', role: 'status' },
                h('div', { className: 'dnp-h2-sub' }, '配置自检提醒'),
                warnings.map((w, i) => h('div', { className: 'dnp-warn-line', key: i },
                  typeof w === 'string' ? w : errText(w))))
            : null)
      }

      /* ────────── 页面 ────────── */
      return h('div', { className: 'dnp-page' },
        h('div', { className: 'dnp-wrap' },
          h('div', { className: 'dnp-head' },
            h('div', null,
              h('h1', { className: 'dnp-h1' }, '燧心 · 本地 NPU 推理'),
              h('div', { className: 'dnp-sub' },
                h(Tag, { tone: anyRunning ? 'ok' : 'mute' }, anyRunning ? '运行中' : '未点火'),
                h('span', null, (cfg.displayName || cfg.provider || 'npu-local') + ' · ' +
                  ((chosen && (chosen.label || chosen.id)) || '自动选择') + ' · 端口 ' + (runningPort || '—')),
                h('span', { className: 'dnp-code' },
                  (cfg.apiUrl || ('http://' + (cfg.bindHost || '127.0.0.1') + ':' + (cfg.frontPort || 52630))) + '/v1'))),
            h(Btn, { small: true, disabled: isPending('ignite'), onClick: () => reloadQuiet(), testid: 'btn-refresh-top' }, '刷新')),
          bootErr
            ? h('div', { className: 'dnp-err', role: 'alert' }, '后端暂时读不到状态：' + bootErr)
            : null,
          h('div', { className: 'dnp-tabs', role: 'tablist', 'aria-label': '燧心面板页签' },
            TABS.map((t, i) => h('button', {
              key: t.id, id: 'dnp-tab-' + t.id, type: 'button', role: 'tab',
              className: 'dnp-tab',
              'aria-selected': tab === t.id ? 'true' : 'false',
              'aria-controls': 'dnp-panel-' + t.id,
              tabIndex: tab === t.id ? 0 : -1,
              'data-dnp': 'tab-' + t.id,
              onClick: () => selectTab(t.id),
              onKeyDown: (e) => onTabKey(e, i),
            }, t.label))),
          h('div', {
            role: 'tabpanel', id: 'dnp-panel-overview', 'aria-labelledby': 'dnp-tab-overview',
            hidden: tab !== 'overview', 'data-dnp': 'panel-overview',
          }, renderOverview()),
          h('div', {
            role: 'tabpanel', id: 'dnp-panel-models', 'aria-labelledby': 'dnp-tab-models',
            hidden: tab !== 'models', 'data-dnp': 'panel-models',
          }, renderModels()),
          h('div', {
            role: 'tabpanel', id: 'dnp-panel-settings', 'aria-labelledby': 'dnp-tab-settings',
            hidden: tab !== 'settings', 'data-dnp': 'panel-settings',
          }, renderSettings())))
    }

    /* 三点状态推导：NPU 火种 / GPU 火线 / 混合链路 */
    function buildEngineTiles({ slots, stSlots, backendList, hy, cfg }) {
      const byId = {}
      for (const x of stSlots) if (x && x.id) byId[x.id] = x
      const readyOf = (x) => !!(byId[x.id] && byId[x.id].ready)
      const npuSlots = slots.filter((x) => x && (x.backend || 'flm') === 'flm')
      const gpuSlots = slots.filter((x) => x && x.backend && x.backend !== 'flm')
      const npuReady = npuSlots.some(readyOf)
      const gpuReady = gpuSlots.some(readyOf)
      const flmB = backendList.find((b) => b && b.id === 'flm') || {}
      const gpuB = backendList.find((b) => b && b.id !== 'flm' && b.installed) || {}
      const npuModel = (npuSlots.find(readyOf) || npuSlots[0] || {}).model || ''
      const gpuModel = (gpuSlots.find(readyOf) || gpuSlots[0] || {}).model || ''
      const eng = (id) => (hy.engines || []).find((e) => e && e.id === id) || {}
      const npuEng = eng('npu')
      const gpuEng = eng('gpu')
      const mode = hy.mode || 'auto'
      let hybridState = 'off'
      let hybridText = '未启用（单引擎照常工作）'
      if (hy.enabled) {
        if (npuReady && gpuReady) { hybridState = 'ok'; hybridText = '双引擎就绪 · 模式 ' + mode }
        else if (npuReady || gpuReady) { hybridState = 'warn'; hybridText = '单引擎在跑，另一侧待点火' }
        else { hybridState = 'warn'; hybridText = '引擎都还没点火' }
      }
      const last = hy.last || hy.active || null
      const lastText = last && last.engine
        ? ('上次 ' + last.engine + (last.mode ? ' / ' + last.mode : '') + (last.ms ? ' · ' + Math.round(last.ms) + ' ms' : ''))
        : (hy.reason || '按请求特征自动分流')
      return [
        {
          id: 'npu',
          name: 'NPU 火种',
          dot: npuReady ? 'ok' : (flmB.installed ? 'warn' : 'fail'),
          state: npuReady ? '已就绪' : (flmB.installed ? '已安装 · 未点火' : '未找到 flm.exe'),
          meta: npuReady
            ? ((npuEng.model || npuModel) + (npuEng.tokps ? ' · ' + npuEng.tokps + ' tok/s' : ''))
            : (flmB.device ? 'NPU · ' + flmB.device : 'FLM · XDNA2'),
        },
        {
          id: 'gpu',
          name: 'GPU 火线',
          dot: gpuReady ? 'ok' : (gpuB.id ? 'warn' : 'fail'),
          state: gpuReady ? '已就绪' : (gpuB.id ? '已安装 · 未点火' : '未安装运行时'),
          meta: gpuReady
            ? ((gpuEng.model || gpuModel) + (gpuEng.tokps ? ' · ' + gpuEng.tokps + ' tok/s' : ''))
            : (gpuB.id ? (gpuB.label + (gpuB.device ? ' · ' + gpuB.device : '')) : 'llama.cpp · Vulkan / ROCm'),
        },
        {
          id: 'hybrid',
          name: '混合链路',
          dot: hybridState,
          state: hybridText,
          meta: hy.enabled ? (lastText + ' · 草稿 ' + (hy.draftModel || '未选') ) : 'amd-hybrid · 可在设置页开启',
        },
      ]
    }

    /* ────────────────────────── 侧栏图标 / 挂载 ────────────────────────── */

    function NpuIcon() {
      return h('svg', {
        width: 16, height: 16, viewBox: '0 0 16 16', fill: 'none', style: { display: 'block' },
        'aria-hidden': 'true',
      },
      h('rect', { x: 2.5, y: 2.5, width: 11, height: 11, rx: 3, stroke: 'currentColor', strokeWidth: 1.3 }),
      h('circle', { cx: 8, cy: 8, r: 2.1, stroke: 'currentColor', strokeWidth: 1.3 }),
      h('path', { d: 'M8 1v1.5M8 13.5V15M1 8h1.5M13.5 8H15', stroke: 'currentColor', strokeWidth: 1.3, strokeLinecap: 'round' }))
    }

    const inject = ['slots', 'layout']

    function apply(ctx) {
      ensureStyle()
      const registerAll = () => {
        const stopPanel = ctx.slots.register({ name: 'main', key: PANEL_ID, inject: () => ({ ctx }) }, PanelBody)
        let stopEntry
        try {
          stopEntry = ctx.slots.register({
            name: 'sidebar.panellist', id: PANEL_ID, order: 43, label: () => 'NPU',
          }, NpuIcon)
        } catch (error) {
          stopPanel()
          throw error
        }
        return () => {
          try { stopEntry() } catch { /* ignore */ }
          try { stopPanel() } catch { /* ignore */ }
        }
      }
      ctx.effect(() => {
        if (typeof ctx.slots.inject === 'function') {
          return ctx.slots.inject('main', () => ctx.slots.inject('sidebar.panellist', () => registerAll()))
        }
        return registerAll()
      }, 'dsh-npu: sidebar entry + main panel (v1.0.0 hearthcore)')
    }

    const mod = { exports: {} }
    mod.exports.apply = apply
    mod.exports.inject = inject
    mod.exports.name = 'dsh-npu'
    mod.exports.version = '1.0.0'
    mod.exports.theme = 'auto'
    return mod.exports
  },
})