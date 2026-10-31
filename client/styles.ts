/**
 * 客户端样式：一次性注入一个 `<style>`，全部类名以 `dshgt-` 前缀隔离。
 *
 * 不 import 宿主的 CSS、不依赖 CSS-in-JS 库：客户端产物只允许 `react`，
 * 样式必须自带，否则在别的宿主版本里会掉样式。
 */
export const STYLE_ID = 'dsh-github-trending-style';

export const CSS = `
.dshgt-root{--gt-fg:var(--dsw-alias-label-primary,#1f2328);--gt-muted:var(--dsw-alias-label-secondary,#6b7280);--gt-bg:var(--dsw-alias-bg-base,#fff);--gt-card:var(--dsw-alias-bg-layer-1,#f8fafc);--gt-border:var(--dsw-alias-border-l2,#e5e7eb);--gt-accent:var(--dsw-alias-state-business-primary,#2563eb);--gt-ok:var(--dsw-alias-state-success-primary,#16a34a);--gt-warn:var(--dsw-alias-state-warn-primary,#d97706);--gt-err:var(--dsw-alias-state-error-primary,#dc2626);color:var(--gt-fg);font-size:14px;line-height:1.55;display:flex;flex-direction:column;gap:12px;}
.dshgt-root *{box-sizing:border-box;}
.dshgt-head{display:flex;align-items:baseline;gap:10px;flex-wrap:wrap;}
.dshgt-title{font-size:15px;font-weight:600;white-space:nowrap;}
.dshgt-sub{color:var(--gt-muted);font-size:12px;}
.dshgt-tabs{display:flex;gap:6px;border-bottom:1px solid var(--gt-border);}
.dshgt-tab{appearance:none;border:none;background:none;padding:6px 10px;font:inherit;color:var(--gt-muted);cursor:pointer;border-bottom:2px solid transparent;}
.dshgt-tab[aria-selected="true"]{color:var(--gt-fg);border-bottom-color:var(--gt-accent);font-weight:600;white-space:nowrap;}
.dshgt-shell{height:100%;min-height:0;overflow:hidden;}
.dshgt-content{flex:1;min-height:0;display:flex;}
.dshgt-scroll{flex:1;min-height:0;overflow-y:auto;display:flex;flex-direction:column;gap:12px;padding-right:4px;}
.dshgt-settings{flex:1;min-height:0;display:grid;grid-template-columns:150px minmax(0,1fr);gap:16px;}
.dshgt-vtabs{display:flex;flex-direction:column;gap:2px;border-right:1px solid var(--gt-border);padding-right:8px;overflow-y:auto;}
.dshgt-vtab{appearance:none;border:none;background:none;text-align:left;padding:7px 10px;border-radius:7px;color:var(--gt-muted);cursor:pointer;font:inherit;font-size:12px;display:flex;align-items:center;gap:6px;}
.dshgt-vtab:hover{background:var(--dsw-alias-interactive-bg-hover,color-mix(in srgb,var(--gt-accent) 8%,transparent));}
.dshgt-vtab[aria-selected="true"]{background:color-mix(in srgb,var(--gt-accent) 12%,transparent);color:var(--gt-fg);font-weight:600;white-space:nowrap;}
.dshgt-vtab-dirty{width:6px;height:6px;border-radius:50%;background:var(--gt-warn);flex:none;margin-left:auto;}
.dshgt-vpanel{min-width:0;min-height:0;overflow-y:auto;display:flex;flex-direction:column;gap:12px;padding-right:4px;}
.dshgt-card{border:1px solid var(--gt-border);border-radius:10px;background:var(--gt-card);padding:12px 14px;display:flex;flex-direction:column;gap:8px;}
.dshgt-card-h{display:flex;align-items:center;gap:8px;flex-wrap:wrap;}
.dshgt-card-h h3{margin:0;font-size:13px;font-weight:600;white-space:nowrap;}
.dshgt-hint{color:var(--gt-muted);font-size:12px;}
.dshgt-desc{margin:0;color:var(--gt-muted);font-size:12px;}
.dshgt-row{display:flex;gap:10px;align-items:center;min-height:28px;flex-wrap:wrap;}
.dshgt-row>label.dshgt-label{width:96px;color:var(--gt-muted);flex:none;font-size:12px;display:flex;align-items:flex-start;gap:5px;}
.dshgt-label-text{flex:1;min-width:0;}
/* 字段说明：圆问号 + 纯 CSS 悬浮气泡（::after 读 data-tip），键盘聚焦同样展开。 */
.dshgt-help{position:relative;flex:none;margin-top:2px;width:14px;height:14px;display:inline-flex;align-items:center;justify-content:center;border:1px solid var(--gt-border);border-radius:50%;background:var(--gt-bg);color:var(--gt-muted);font-size:10px;line-height:1;font-weight:600;cursor:help;user-select:none;outline:none;}
.dshgt-help:hover,.dshgt-help:focus-visible{color:var(--gt-fg);border-color:color-mix(in srgb,var(--gt-accent) 55%,var(--gt-border));}
.dshgt-help::after{content:attr(data-tip);position:absolute;left:0;top:calc(100% + 7px);z-index:30;width:max-content;max-width:280px;padding:7px 9px;border-radius:8px;background:var(--dsw-alias-bg-layer-2,var(--gt-card));color:var(--gt-fg);border:1px solid var(--gt-border);font-size:12px;font-weight:400;line-height:1.55;letter-spacing:0;text-align:left;white-space:normal;overflow-wrap:break-word;box-shadow:0 10px 26px rgba(0,0,0,.28);opacity:0;visibility:hidden;pointer-events:none;transition:opacity .12s ease,visibility .12s;}
.dshgt-help:hover::after,.dshgt-help:focus-visible::after{opacity:1;visibility:visible;}
.dshgt-inline{display:flex;gap:8px;align-items:center;flex-wrap:wrap;}
.dshgt-input,.dshgt-select,.dshgt-textarea{font:inherit;color:inherit;background:var(--gt-bg);border:1px solid var(--gt-border);border-radius:7px;padding:5px 8px;min-width:0;}
.dshgt-input:focus,.dshgt-select:focus,.dshgt-textarea:focus{outline:2px solid color-mix(in srgb,var(--gt-accent) 35%,transparent);outline-offset:1px;}
.dshgt-mono{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:12px;}
.dshgt-btn{appearance:none;font:inherit;cursor:pointer;border-radius:7px;border:1px solid var(--gt-border);background:var(--gt-bg);padding:5px 10px;color:inherit;}
.dshgt-btn:hover:not(:disabled){border-color:color-mix(in srgb,var(--gt-accent) 45%,var(--gt-border));}
.dshgt-btn:disabled{opacity:.55;cursor:not-allowed;}
.dshgt-btn-primary{background:var(--dsw-alias-button-primary-fill,var(--gt-accent));border-color:var(--dsw-alias-button-primary-fill,var(--gt-accent));color:var(--dsw-alias-label-primary-foreground,#fff);}
.dshgt-default{display:flex;align-items:center;justify-content:space-between;gap:10px;border:1px solid var(--gt-border);border-radius:9px;padding:10px 12px;background:var(--dsw-alias-bg-layer-2,var(--gt-card));}
.dshgt-btn-danger{background:transparent;border-color:var(--gt-err);color:var(--gt-err);}
.dshgt-btn-sm{padding:3px 8px;font-size:12px;}
.dshgt-pill{display:inline-flex;align-items:center;gap:6px;border:1px solid var(--gt-border);border-radius:999px;padding:2px 9px;font-size:12px;background:var(--gt-bg);}
.dshgt-dot{width:7px;height:7px;border-radius:50%;background:var(--gt-muted);flex:none;}
.dshgt-dot.ok{background:var(--gt-ok);} .dshgt-dot.warn{background:var(--gt-warn);} .dshgt-dot.err{background:var(--gt-err);}
.dshgt-alert{border:1px solid var(--gt-border);border-left:3px solid var(--gt-warn);border-radius:8px;padding:8px 10px;background:color-mix(in srgb,var(--gt-warn) 8%,var(--gt-bg));font-size:12px;}
.dshgt-alert.err{border-left-color:var(--gt-err);background:color-mix(in srgb,var(--gt-err) 8%,var(--gt-bg));}
.dshgt-alert.ok{border-left-color:var(--gt-ok);background:color-mix(in srgb,var(--gt-ok) 8%,var(--gt-bg));}
.dshgt-alert b{display:block;margin-bottom:2px;font-size:12px;}
.dshgt-steps{list-style:none;margin:0;padding:0;display:flex;flex-direction:column;gap:4px;}
.dshgt-step{display:flex;align-items:center;gap:8px;font-size:12px;color:var(--gt-muted);}
.dshgt-step .st{margin-left:auto;font-size:11px;}
.dshgt-step[data-state="done"]{color:var(--gt-fg);} .dshgt-step[data-state="done"] .st{color:var(--gt-ok);}
.dshgt-step[data-state="active"]{color:var(--gt-fg);} .dshgt-step[data-state="active"] .st{color:var(--gt-accent);}
.dshgt-step[data-state="failed"] .st{color:var(--gt-err);}
.dshgt-kv{display:grid;grid-template-columns:auto 1fr;gap:3px 12px;margin:0;font-size:12px;}
.dshgt-kv dt{color:var(--gt-muted);} .dshgt-kv dd{margin:0;}
.dshgt-table{width:100%;border-collapse:collapse;font-size:12px;}
.dshgt-table th,.dshgt-table td{text-align:left;padding:5px 8px;border-bottom:1px solid var(--gt-border);vertical-align:top;}
.dshgt-table th{color:var(--gt-muted);font-weight:500;}
.dshgt-chips{display:flex;gap:6px;flex-wrap:wrap;}
.dshgt-period-list{display:flex;flex-direction:column;gap:4px;flex:1;min-width:0;}
.dshgt-period{display:flex;align-items:center;gap:8px;font-size:13px;color:var(--gt-fg);}
.dshgt-period-check{color:var(--gt-ok);font-size:12px;line-height:1;}
.dshgt-chip{appearance:none;font:inherit;cursor:pointer;border:1px solid var(--gt-border);background:var(--gt-bg);border-radius:999px;padding:2px 10px;font-size:12px;color:var(--gt-muted);}
.dshgt-chip[aria-pressed="true"]{background:color-mix(in srgb,var(--gt-accent) 14%,var(--gt-bg));border-color:var(--gt-accent);color:var(--gt-fg);}
.dshgt-switch{appearance:none;cursor:pointer;width:36px;height:20px;border-radius:999px;border:1px solid var(--gt-border);background:var(--gt-muted);position:relative;transition:background .15s;}
.dshgt-switch::after{content:"";position:absolute;top:2px;left:2px;width:14px;height:14px;border-radius:50%;background:#fff;transition:transform .15s;}
.dshgt-switch[aria-checked="true"]{background:var(--gt-accent);}
.dshgt-switch[aria-checked="true"]::after{transform:translateX(16px);}
.dshgt-footer{display:flex;gap:8px;align-items:center;flex-wrap:wrap;}
.dshgt-monobox{margin:0;padding:8px;border-radius:7px;background:color-mix(in srgb,var(--gt-fg) 6%,var(--gt-bg));max-height:220px;overflow:auto;white-space:pre-wrap;word-break:break-word;}
.dshgt-modal-mask{position:fixed;inset:0;background:var(--dsw-alias-bg-mask-1,rgba(15,23,42,.38));display:flex;align-items:center;justify-content:center;z-index:2147483000;}
.dshgt-modal{background:var(--gt-bg);border-radius:12px;border:1px solid var(--gt-border);max-width:640px;width:calc(100% - 32px);max-height:80vh;overflow:auto;padding:16px;display:flex;flex-direction:column;gap:10px;box-shadow:0 20px 50px rgba(15,23,42,.25);}

/* ——— 01 工作台外壳 ——— */
.dshgt-shell{gap:0;height:100%;min-height:0;overflow:hidden;}
.dshgt-app{flex:1;min-height:0;display:flex;flex-direction:column;background:var(--gt-bg);}
.dshgt-rail{background:color-mix(in srgb,var(--gt-fg) 3%,var(--gt-bg));border-right:1px solid var(--gt-border);display:flex;flex-direction:column;padding:14px 10px 12px;min-height:0;overflow:hidden;}
.dshgt-brand{display:flex;align-items:center;gap:9px;padding:2px 6px 16px;}
.dshgt-brand svg{flex:none;border-radius:8px;}
.dshgt-brand-name{font-size:13.5px;font-weight:600;line-height:1.3;}
.dshgt-brand-ver{font-size:11px;color:var(--gt-muted);margin-top:1px;min-height:15px;}
.dshgt-nav{display:flex;flex-direction:column;gap:2px;}
.dshgt-nav-item{display:flex;align-items:center;gap:9px;height:36px;padding:0 9px;border:1px solid transparent;border-radius:8px;background:none;text-align:left;font-family:inherit;font-size:13.5px;color:var(--gt-muted);width:100%;cursor:pointer;}
.dshgt-nav-item svg{flex:none;opacity:.82;}
.dshgt-nav-item:hover{background:color-mix(in srgb,var(--gt-fg) 6%,var(--gt-bg));color:var(--gt-fg);}
.dshgt-nav-item.on{background:var(--gt-bg);border-color:var(--gt-border);color:var(--gt-fg);font-weight:600;white-space:nowrap;}
.dshgt-nav-item.on svg{opacity:1;}
.dshgt-nav-tail{margin-left:auto;display:flex;align-items:center;gap:5px;font-size:11.5px;color:var(--gt-muted);font-weight:400;}
.dshgt-rail-spacer{flex:1;min-height:16px;}
.dshgt-rail-status{border-top:1px solid var(--gt-border);padding:12px 8px 10px;}
.dshgt-rail-cap{font-size:11.5px;color:var(--gt-muted);margin-bottom:3px;}
.dshgt-rail-time{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:14px;line-height:1.35;}
.dshgt-rail-count{font-size:12px;color:var(--gt-muted);margin-top:1px;min-height:18px;}
.dshgt-rail-ready{display:flex;align-items:center;gap:7px;margin-top:10px;font-size:12px;color:var(--gt-muted);}
.dshgt-rail-pkg{border-top:1px solid var(--gt-border);padding:10px 8px 8px;}
.dshgt-pkg-name{border:0;background:none;padding:0;text-align:left;font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:10px;line-height:1.45;color:var(--gt-muted);word-break:break-all;cursor:pointer;max-width:100%;}
.dshgt-pkg-name:hover{color:var(--gt-fg);}
.dshgt-pkg-sub{display:flex;align-items:center;gap:8px;margin-top:3px;font-size:11px;color:var(--gt-muted);}
.dshgt-pkg-sub .dshgt-mono{font-size:10.5px;color:var(--gt-fg);}
.dshgt-pkg-sub a{display:inline-flex;align-items:center;gap:3px;font-size:11px;color:var(--gt-accent);text-decoration:none;}
.dshgt-pkg-sub a:hover{text-decoration:underline;}
.dshgt-pkg-copy{width:22px;height:22px;margin-left:auto;display:grid;place-items:center;border:0;background:none;border-radius:4px;color:var(--gt-muted);cursor:pointer;}
.dshgt-pkg-copy:hover{background:color-mix(in srgb,var(--gt-fg) 7%,var(--gt-bg));color:var(--gt-fg);}
.dshgt-pkg-copy:disabled{opacity:.4;cursor:not-allowed;}
.dshgt-main{flex:1;display:flex;flex-direction:column;min-width:0;min-height:0;background:var(--gt-bg);}
.dshgt-page-head{display:flex;align-items:flex-start;gap:16px;padding:20px 30px 14px;border-bottom:1px solid color-mix(in srgb,var(--gt-border) 70%,transparent);flex:none;}
.dshgt-page-heading{min-width:0;}
.dshgt-page-head h1{margin:0;font-size:21px;line-height:1.25;font-weight:650;letter-spacing:-.012em;}
.dshgt-dek{margin:4px 0 0;font-size:13px;color:var(--gt-muted);max-width:580px;line-height:1.5;}
.dshgt-head-actions{margin-left:auto;display:flex;align-items:center;gap:8px;padding-top:2px;flex:none;}
.dshgt-main-body{flex:1;min-height:0;display:flex;min-width:0;}
.dshgt-scroll{flex:1;min-height:0;overflow-y:auto;overflow-x:hidden;scrollbar-gutter:stable;}
.dshgt-main-body > .dshgt-settings{flex:1;min-height:0;padding:16px 24px 20px;}
.dshgt-view{padding:22px 30px 38px;max-width:1180px;width:100%;display:flex;flex-direction:column;gap:18px;}
.dshgt-grow{flex:1;min-width:0;}
.dshgt-dim{font-size:12px;color:var(--gt-muted);}
.dshgt-empty{padding:48px 0;text-align:center;color:var(--gt-muted);font-size:13px;}
.dshgt-tag{display:inline-flex;align-items:center;height:20px;padding:0 7px;border:1px solid var(--gt-border);border-radius:999px;font-size:11px;color:var(--gt-muted);background:var(--gt-bg);white-space:nowrap;}
.dshgt-inline-tag{margin-left:6px;vertical-align:1px;}

/* ——— 顶部身份条（第一行）：名称 / 版本 / 完整包名 / GitHub / 检查更新 ——— */
.dshgt-idbar{display:flex;align-items:center;gap:10px;height:48px;padding:0 18px;border-bottom:1px solid var(--gt-border);flex:none;background:var(--gt-bg);}
.dshgt-idbar .dshgt-brand{display:flex;align-items:center;gap:9px;padding:0;flex:none;}
.dshgt-idbar .dshgt-brand svg{width:22px;height:22px;flex:none;border-radius:6px;}
.dshgt-brand-name{font-size:13.5px;font-weight:650;letter-spacing:-.01em;white-space:nowrap;line-height:1.3;}
.dshgt-id-ver{appearance:none;font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:11px;color:var(--gt-fg);background:var(--gt-card);border:1px solid var(--gt-border);border-radius:999px;padding:1px 7px;line-height:16px;cursor:pointer;flex:none;}
.dshgt-id-ver:hover{border-color:color-mix(in srgb,var(--gt-accent) 45%,var(--gt-border));}
.dshgt-id-sep{width:1px;height:16px;background:var(--gt-border);flex:none;}
.dshgt-id-pkg{appearance:none;border:0;background:none;padding:2px 4px;border-radius:5px;color:var(--gt-muted);cursor:pointer;font-size:12px;max-width:44vw;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;flex:none;}
.dshgt-id-pkg:hover{color:var(--gt-fg);background:color-mix(in srgb,var(--gt-fg) 5%,var(--gt-bg));}
.dshgt-idbar-right{margin-left:auto;display:flex;align-items:center;gap:10px;flex:none;}
.dshgt-id-gh{display:inline-flex;align-items:center;justify-content:center;width:30px;height:30px;border-radius:7px;color:var(--gt-muted);border:1px solid transparent;}
.dshgt-id-gh:hover{color:var(--gt-fg);background:color-mix(in srgb,var(--gt-fg) 6%,var(--gt-bg));border-color:var(--gt-border);}
.dshgt-id-upd{display:flex;align-items:center;gap:10px;}
.dshgt-id-status{font-size:12px;color:var(--gt-muted);white-space:nowrap;display:inline-flex;align-items:center;gap:6px;}
.dshgt-id-status.ok{color:var(--gt-ok);}
.dshgt-id-status.new{color:var(--gt-warn);}
.dshgt-id-status.err{color:var(--gt-err);}
.dshgt-id-actions{display:flex;align-items:center;gap:8px;}

/* ——— 横向 tab（第二行）+ 右侧状态 ——— */
.dshgt-tabsbar{display:flex;align-items:stretch;gap:16px;height:46px;padding:0 24px;border-bottom:1px solid var(--gt-border);flex:none;background:var(--gt-bg);}
.dshgt-tabnav{display:flex;align-items:stretch;gap:2px;height:100%;}
.dshgt-tab{display:flex;align-items:center;gap:7px;padding:0 12px;border:0;background:none;color:var(--gt-muted);cursor:pointer;font:inherit;font-size:13.5px;position:relative;border-bottom:2px solid transparent;margin-bottom:-1px;}
.dshgt-tab svg{opacity:.8;}
.dshgt-tab:hover{color:var(--gt-fg);}
.dshgt-tab.on{color:var(--gt-fg);font-weight:600;border-bottom-color:var(--gt-accent);}
.dshgt-tab.on svg{opacity:1;color:var(--gt-accent);}
.dshgt-tab-tail{font-size:10.5px;color:var(--gt-muted);background:var(--gt-card);border:1px solid var(--gt-border);border-radius:999px;padding:0 5px;line-height:15px;}
.dshgt-tabsbar-status{margin-left:auto;display:flex;align-items:center;gap:16px;flex:none;}
.dshgt-status-item{display:inline-flex;align-items:center;gap:7px;font-size:12px;color:var(--gt-muted);white-space:nowrap;}
.dshgt-status-key{color:var(--gt-muted);}
.dshgt-status-val{color:var(--gt-fg);font-weight:600;}
.dshgt-status-sub{color:var(--gt-muted);}
@media (max-width:1100px){ .dshgt-id-pkg{max-width:26vw;} }
@media (max-width:860px){ .dshgt-id-pkg{display:none;} .dshgt-status-item.dshgt-next{display:none;} }

/* ——— 概览 ——— */
.dshgt-delivery{border:1px solid var(--gt-border);border-radius:12px;padding:18px 20px 16px;background:var(--gt-card);display:flex;flex-direction:column;gap:6px;}
.dshgt-delivery-top{display:flex;align-items:center;gap:10px;flex-wrap:wrap;}
.dshgt-pill-mini{margin-left:auto;font-size:12px;color:var(--gt-muted);border:1px solid var(--gt-border);border-radius:999px;padding:2px 9px;background:var(--gt-bg);}
.dshgt-delivery h2{margin:4px 0 0;font-size:18px;font-weight:600;letter-spacing:-.01em;line-height:1.35;word-break:break-word;}
.dshgt-when{display:flex;gap:14px;flex-wrap:wrap;font-size:12.5px;color:var(--gt-muted);}
.dshgt-when a{color:var(--gt-accent);text-decoration:none;}
.dshgt-when a:hover{text-decoration:underline;}
.dshgt-delivery-error{margin-top:6px;}
.dshgt-artifacts{display:flex;align-items:center;gap:8px;flex-wrap:wrap;margin-top:10px;}
.dshgt-filechip{display:inline-flex;align-items:center;gap:7px;min-height:32px;padding:0 10px;border:1px solid var(--gt-border);border-radius:8px;background:var(--gt-bg);font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:12px;color:var(--gt-fg);cursor:pointer;text-align:left;max-width:100%;overflow:hidden;}
.dshgt-filechip .dshgt-mono{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}
.dshgt-filechip:hover{border-color:color-mix(in srgb,var(--gt-accent) 40%,var(--gt-border));}
.dshgt-filechip-static{cursor:default;}
.dshgt-filechip-static:hover{border-color:var(--gt-border);}
.dshgt-facts{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:0;border-top:1px solid var(--gt-border);margin-top:12px;padding-top:10px;}
.dshgt-fact{padding:0 14px;border-left:1px solid var(--gt-border);min-width:0;}
.dshgt-fact:first-child{padding-left:0;border-left:0;}
.dshgt-fact-k{font-size:11.5px;color:var(--gt-muted);margin-bottom:2px;}
.dshgt-fact-v{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:12px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}
.dshgt-block{display:flex;flex-direction:column;gap:8px;}
.dshgt-section-label{display:flex;align-items:center;gap:9px;font-size:12px;color:var(--gt-muted);letter-spacing:.02em;}
.dshgt-section-label:after{content:"";height:1px;flex:1;background:color-mix(in srgb,var(--gt-border) 70%,transparent);}
.dshgt-section-tail{margin-left:auto;font-size:11.5px;color:var(--gt-muted);}
.dshgt-ready-list{border-top:1px solid var(--gt-border);}
.dshgt-ready-row{display:grid;grid-template-columns:16px 108px minmax(0,1fr) auto;align-items:center;gap:12px;min-height:46px;border-bottom:1px solid color-mix(in srgb,var(--gt-border) 70%,transparent);font-size:13.5px;}
.dshgt-ready-label{color:var(--gt-muted);font-size:13px;}
.dshgt-ready-value{color:var(--gt-fg);min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}
.dshgt-ready-extra{color:var(--gt-muted);font-size:12px;margin-left:7px;}
.dshgt-linkbtn{border:0;background:none;color:var(--gt-accent);font-family:inherit;font-size:12.5px;padding:6px 2px;border-radius:4px;cursor:pointer;}
.dshgt-linkbtn:hover{text-decoration:underline;}
.dshgt-week{display:flex;gap:6px;align-items:stretch;}
.dshgt-day{flex:1;min-width:0;border:1px solid var(--gt-border);border-radius:8px;padding:8px;background:var(--gt-card);display:flex;flex-direction:column;gap:5px;text-align:left;font-family:inherit;color:inherit;}
.dshgt-day-clickable{cursor:pointer;}
.dshgt-day-clickable:hover{border-color:color-mix(in srgb,var(--gt-accent) 40%,var(--gt-border));}
.dshgt-day-date{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:11px;color:var(--gt-muted);}
.dshgt-day-status{display:flex;align-items:center;gap:6px;font-size:11.5px;color:var(--gt-muted);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;}
.dshgt-lamp{width:7px;height:7px;border-radius:50%;background:var(--gt-muted);flex:none;}
.dshgt-lamp.ok{background:var(--gt-ok);}
.dshgt-lamp.warn{background:var(--gt-warn);}
.dshgt-lamp.err{background:var(--gt-err);}
.dshgt-live{border:1px solid var(--gt-border);border-radius:12px;padding:16px 18px;background:var(--gt-card);display:flex;flex-direction:column;gap:8px;}
.dshgt-live-top{display:flex;align-items:center;gap:9px;font-size:13px;flex-wrap:wrap;}
.dshgt-live-elapsed{margin-left:auto;font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:13px;color:var(--gt-muted);}
.dshgt-live-note{display:flex;gap:10px;flex-wrap:wrap;font-size:12px;color:var(--gt-muted);line-height:1.6;}
.dshgt-live-actions{display:flex;gap:8px;}
.dshgt-spinner{width:13px;height:13px;border-radius:50%;border:1.6px solid var(--gt-border);border-top-color:var(--gt-accent);animation:dshgt-spin .8s linear infinite;display:inline-block;flex:none;}
@keyframes dshgt-spin{to{transform:rotate(360deg);}}

/* ——— 日报 ——— */
.dshgt-digest{padding-top:20px;gap:12px;}
.dshgt-digest-subbar{display:flex;align-items:center;gap:10px;flex-wrap:wrap;}
.dshgt-datenav{display:flex;align-items:center;gap:2px;border:1px solid var(--gt-border);border-radius:8px;background:var(--gt-card);padding:2px;}
.dshgt-icon-btn{width:28px;height:28px;display:grid;place-items:center;border:1px solid transparent;background:var(--gt-bg);border-radius:6px;color:var(--gt-fg);font-family:inherit;font-size:18px;line-height:1;cursor:pointer;flex:none;}
.dshgt-icon-btn:hover:not(:disabled){background:color-mix(in srgb,var(--gt-fg) 7%,var(--gt-bg));border-color:var(--gt-border);}
.dshgt-icon-btn:disabled{opacity:.3;cursor:not-allowed;}
.dshgt-dateselect{appearance:none;height:28px;border:0;background:transparent;font-family:inherit;font-size:13px;color:var(--gt-fg);padding:0 8px;min-width:210px;max-width:320px;cursor:pointer;}
.dshgt-digest-sheet{max-width:900px;width:100%;border:1px solid var(--gt-border);border-radius:12px;background:var(--gt-card);overflow:hidden;}
.dshgt-digest-body{display:flex;flex-direction:column;min-width:0;}
.dshgt-digest-bar{display:flex;align-items:center;gap:8px;flex-wrap:wrap;padding:9px 12px;border-bottom:1px solid color-mix(in srgb,var(--gt-border) 70%,transparent);background:color-mix(in srgb,var(--gt-fg) 2.5%,var(--gt-card));}
.dshgt-seg{display:inline-flex;border:1px solid var(--gt-border);border-radius:8px;padding:2px;background:var(--gt-bg);gap:2px;}
.dshgt-seg button{border:0;background:none;height:26px;padding:0 11px;border-radius:6px;font-family:inherit;font-size:12.5px;color:var(--gt-muted);cursor:pointer;}
.dshgt-seg button.on{background:var(--gt-card);color:var(--gt-fg);font-weight:600;white-space:nowrap;}
.dshgt-digest-doc{padding:26px 32px 22px;min-width:0;}
.dshgt-doc-meta{display:flex;gap:12px;flex-wrap:wrap;font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:11px;color:var(--gt-muted);padding-bottom:12px;border-bottom:1px solid color-mix(in srgb,var(--gt-border) 70%,transparent);}
.dshgt-digest-raw{margin:0;padding:22px 28px;font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:12px;line-height:1.75;white-space:pre-wrap;word-break:break-word;color:var(--gt-muted);background:color-mix(in srgb,var(--gt-fg) 2.5%,var(--gt-card));max-height:640px;overflow:auto;}
.dshgt-digest-loading{padding:40px 28px;color:var(--gt-muted);font-size:13px;}
.dshgt-digest-empty{padding:42px 36px 46px;max-width:720px;}
.dshgt-status-line{display:flex;align-items:center;gap:8px;font-size:12.5px;color:var(--gt-muted);}
.dshgt-status-line b{color:var(--gt-fg);font-weight:600;white-space:nowrap;}
.dshgt-digest-empty h2{margin:14px 0 6px;font-size:20px;font-weight:650;letter-spacing:-.012em;}
.dshgt-digest-empty p{margin:0;max-width:580px;font-size:13.5px;line-height:1.7;color:var(--gt-muted);}
.dshgt-digest-error{margin-top:10px;color:var(--gt-err);}
.dshgt-actions{display:flex;gap:8px;flex-wrap:wrap;margin-top:16px;}
.dshgt-md{font-size:14px;line-height:1.7;color:var(--gt-fg);word-break:break-word;}
.dshgt-md-h{margin:20px 0 8px;font-weight:650;line-height:1.35;letter-spacing:-.01em;}
.dshgt-md-h1{font-size:24px;margin-top:0;}
.dshgt-md-h2{font-size:18px;}
.dshgt-md-h3{font-size:15.5px;}
.dshgt-md-h4,.dshgt-md-h5,.dshgt-md-h6{font-size:14px;}
.dshgt-md-p{margin:8px 0;color:color-mix(in srgb,var(--gt-fg) 84%,var(--gt-muted));}
.dshgt-md-list{margin:8px 0;padding-left:22px;}
.dshgt-md-list li{margin:3px 0;}
.dshgt-md-quote{margin:12px 0;padding:2px 0 2px 14px;border-left:3px solid var(--gt-border);color:var(--gt-muted);}
.dshgt-md-tablewrap{margin:12px 0;border:1px solid var(--gt-border);border-radius:8px;overflow-x:auto;}
.dshgt-md-table{width:100%;min-width:560px;border-collapse:collapse;font-size:13px;line-height:1.6;}
.dshgt-md-table th,.dshgt-md-table td{padding:7px 10px;text-align:left;vertical-align:top;border-bottom:1px solid color-mix(in srgb,var(--gt-border) 65%,transparent);word-break:normal;overflow-wrap:break-word;}
.dshgt-md-table th{background:color-mix(in srgb,var(--gt-fg) 4%,var(--gt-card));font-weight:600;white-space:nowrap;}
.dshgt-md-table tbody tr:last-child td{border-bottom:0;}
.dshgt-md-table tbody tr:nth-child(even){background:color-mix(in srgb,var(--gt-fg) 2%,var(--gt-card));}
.dshgt-md-pre{margin:12px 0;padding:12px 14px;border-radius:8px;background:color-mix(in srgb,var(--gt-fg) 5%,var(--gt-card));overflow:auto;font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:12px;line-height:1.6;}
.dshgt-md-code{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:12px;background:color-mix(in srgb,var(--gt-fg) 7%,var(--gt-card));padding:1px 4px;border-radius:4px;}
.dshgt-md-hr{border:0;border-top:1px solid var(--gt-border);margin:18px 0;}
.dshgt-md a{color:var(--gt-accent);text-decoration:none;}
.dshgt-md a:hover{text-decoration:underline;}

/* ——— 周期标签 / 分段 ——— */
.dshgt-pchip{display:inline-flex;align-items:center;justify-content:center;height:20px;padding:0 8px;border-radius:999px;font-size:11px;font-weight:600;line-height:18px;white-space:nowrap;border:1px solid var(--gt-border);color:var(--gt-muted);background:var(--gt-bg);}
.dshgt-pchip.daily{color:#2563eb;border-color:#dbeafe;background:#eff6ff;}
.dshgt-pchip.weekly{color:#7c3aed;border-color:#ddd6fe;background:#f5f3ff;}
.dshgt-pchip.monthly{color:#0f766e;border-color:#99f6e4;background:#f0fdfa;}
.dshgt-period-seg{display:inline-flex;border:1px solid var(--gt-border);border-radius:9px;padding:3px;background:var(--gt-card);gap:3px;}
.dshgt-period-seg button{display:inline-flex;align-items:center;gap:7px;border:0;background:none;height:30px;padding:0 12px;border-radius:7px;font:inherit;font-size:13px;color:var(--gt-muted);cursor:pointer;}
.dshgt-period-seg button:hover{color:var(--gt-fg);}
.dshgt-period-seg button.on{background:var(--gt-bg);color:var(--gt-fg);font-weight:600;box-shadow:0 1px 2px rgba(15,23,42,.08);}
.dshgt-period-count{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:11px;color:var(--gt-muted);background:color-mix(in srgb,var(--gt-fg) 6%,var(--gt-bg));border-radius:999px;padding:0 6px;line-height:16px;}
.dshgt-period-seg button.on .dshgt-period-count{color:var(--gt-accent);background:color-mix(in srgb,var(--gt-accent) 12%,var(--gt-bg));}
.dshgt-overview-seg{margin-bottom:8px;}
.dshgt-overview-empty{padding:14px 2px;}

/* ——— 运行记录 ——— */
.dshgt-runs-head{display:flex;align-items:center;gap:10px;flex-wrap:wrap;}
.dshgt-runs-filter{display:flex;gap:4px;margin-left:auto;}
.dshgt-run-list{border-top:1px solid var(--gt-border);}
.dshgt-run-item{border-bottom:1px solid color-mix(in srgb,var(--gt-border) 70%,transparent);}
.dshgt-run-row{display:grid;grid-template-columns:18px 120px 56px minmax(0,1fr) 78px 74px 20px;align-items:center;gap:12px;min-height:52px;width:100%;padding:0 6px;border:0;background:none;text-align:left;font-family:inherit;color:var(--gt-fg);cursor:pointer;border-radius:6px;}
.dshgt-run-row:hover{background:color-mix(in srgb,var(--gt-fg) 4%,var(--gt-bg));}
.dshgt-run-date{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:12px;color:var(--gt-muted);white-space:nowrap;}
.dshgt-run-what{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:13px;}
.dshgt-run-muted{color:var(--gt-muted);font-size:12px;margin-left:6px;}
.dshgt-run-files,.dshgt-run-duration{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:12px;color:var(--gt-muted);text-align:right;}
.dshgt-run-chev{color:var(--gt-muted);text-align:center;transition:transform .15s;}
.dshgt-run-item.open .dshgt-run-chev{transform:rotate(90deg);}
.dshgt-run-detail{padding:2px 6px 16px 30px;display:flex;flex-direction:column;gap:10px;}
.dshgt-detail-grid{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:12px 22px;padding:12px 0;border-top:1px solid color-mix(in srgb,var(--gt-border) 70%,transparent);}
.dshgt-detail-k{font-size:11.5px;color:var(--gt-muted);}
.dshgt-detail-v{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:12px;word-break:break-all;}
.dshgt-detail-v a{color:var(--gt-accent);text-decoration:none;}
.dshgt-detail-v a:hover{text-decoration:underline;}
.dshgt-run-actions{display:flex;align-items:center;gap:10px;flex-wrap:wrap;}

/* ——— 日志抽屉 / 关于 ——— */
.dshgt-log-modal{max-width:820px;width:calc(100% - 32px);}
.dshgt-log-head{display:flex;align-items:center;gap:10px;flex-wrap:wrap;}
.dshgt-log-title{margin:0;font-size:15px;}
.dshgt-log-head .dshgt-btn{margin-left:auto;}
.dshgt-log-pre{margin:0;max-height:52vh;overflow:auto;padding:12px;border-radius:8px;background:color-mix(in srgb,var(--gt-fg) 5%,var(--gt-card));font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:12px;line-height:1.6;white-space:pre-wrap;word-break:break-word;}
.dshgt-log-foot{display:flex;align-items:center;gap:10px;flex-wrap:wrap;}
.dshgt-about{max-width:520px;}
.dshgt-about-head{display:flex;align-items:center;gap:10px;}
.dshgt-about-title{margin:0;font-size:16px;}
.dshgt-about-head .dshgt-btn{margin-left:auto;}
.dshgt-about-pkg{display:flex;align-items:center;width:100%;text-align:left;border:1px solid var(--gt-border);background:var(--gt-card);border-radius:8px;padding:9px 10px;cursor:pointer;font-family:inherit;color:inherit;transition:border-color .12s ease,background .12s ease;}
.dshgt-about-pkg:hover{border-color:color-mix(in srgb,var(--gt-accent) 40%,var(--gt-border));background:color-mix(in srgb,var(--gt-fg) 4%,var(--gt-card));}
.dshgt-about-pkg.is-copied{border-color:color-mix(in srgb,var(--gt-ok) 45%,var(--gt-border));}
.dshgt-about-pkg .dshgt-mono{font-size:12px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;user-select:text;}
.dshgt-about .dshgt-kv{grid-template-columns:110px 1fr;}
.dshgt-about .dshgt-kv a{color:var(--gt-accent);text-decoration:none;}
.dshgt-about .dshgt-kv a:hover{text-decoration:underline;}
.dshgt-about-core{display:inline-flex;align-items:center;gap:7px;}
.dshgt-about-gh{display:inline-flex;align-items:center;justify-content:center;color:var(--gt-muted);}
.dshgt-about-gh:hover{color:var(--gt-fg);}
.dshgt-gh{width:15px;height:15px;display:block;fill:currentColor;}
/* 关于弹层的更新行：与身份条同构（左侧状态 + 右侧单按钮），无标题、无说明。 */
.dshgt-about-upd{display:flex;align-items:center;justify-content:space-between;gap:12px;margin-top:6px;padding-top:12px;border-top:1px solid color-mix(in srgb,var(--gt-border) 70%,transparent);}
.dshgt-about-status{display:inline-flex;align-items:center;gap:7px;font-size:12px;color:var(--gt-muted);}
.dshgt-about-status::before{content:"";width:7px;height:7px;border-radius:50%;background:currentColor;flex:none;opacity:.9;}
.dshgt-about-status.ok{color:var(--gt-ok);}
.dshgt-about-status.new{color:var(--gt-warn);}
.dshgt-about-status.err{color:var(--gt-err);}
.dshgt-about-actions{display:flex;align-items:center;gap:8px;flex:none;}

@media (max-width:1100px){
  .dshgt-app{grid-template-columns:190px minmax(0,1fr);}
  .dshgt-page-head{padding:18px 22px 12px;}
  .dshgt-view{padding:18px 22px 30px;}
  .dshgt-facts{grid-template-columns:repeat(2,minmax(0,1fr));row-gap:10px;}
  .dshgt-fact:nth-child(3){padding-left:0;border-left:0;}
  .dshgt-week{flex-wrap:wrap;}
  .dshgt-day{flex:1 1 88px;}
  .dshgt-run-row{grid-template-columns:18px 104px 52px minmax(0,1fr) 70px 20px;}
  .dshgt-run-files{display:none;}
  .dshgt-detail-grid{grid-template-columns:repeat(2,minmax(0,1fr));}
  .dshgt-dateselect{min-width:180px;}
}
@media (max-width:980px){
  .dshgt-app{grid-template-columns:172px minmax(0,1fr);}
  .dshgt-page-head h1{font-size:19px;}
  .dshgt-dek{font-size:12.5px;}
  .dshgt-main-body > .dshgt-settings{padding:14px 18px 18px;}
}
`;

export function injectStyles(): () => void {
  if (typeof document === 'undefined') return () => undefined;
  const existing = document.getElementById(STYLE_ID);
  if (existing !== null) return () => undefined;
  const style = document.createElement('style');
  style.id = STYLE_ID;
  style.textContent = CSS;
  document.head.appendChild(style);
  return () => {
    style.remove();
  };
}
