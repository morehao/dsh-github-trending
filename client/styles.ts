/**
 * 客户端样式：一次性注入一个 `<style>`，全部类名以 `dshgt-` 前缀隔离。
 *
 * 不 import 宿主的 CSS、不依赖 CSS-in-JS 库：客户端产物只允许 `react`，
 * 样式必须自带，否则在别的宿主版本里会掉样式。
 */
export const STYLE_ID = 'dsh-github-trending-style';

export const CSS = `
.dshgt-root{--gt-fg:var(--dsw-alias-label-primary,#1f2328);--gt-muted:var(--dsw-alias-label-secondary,#6b7280);--gt-bg:var(--dsw-alias-bg-base,#fff);--gt-card:var(--dsw-alias-bg-layer-1,#f8fafc);--gt-border:var(--dsw-alias-border-l2,#e5e7eb);--gt-accent:var(--dsw-alias-state-business-primary,#2563eb);--gt-ok:var(--dsw-alias-state-success-primary,#16a34a);--gt-warn:var(--dsw-alias-state-warn-primary,#d97706);--gt-err:var(--dsw-alias-state-error-primary,#dc2626);color:var(--gt-fg);font-size:13px;line-height:1.5;display:flex;flex-direction:column;gap:12px;}
.dshgt-root *{box-sizing:border-box;}
.dshgt-head{display:flex;align-items:baseline;gap:10px;flex-wrap:wrap;}
.dshgt-title{font-size:15px;font-weight:600;}
.dshgt-sub{color:var(--gt-muted);font-size:12px;}
.dshgt-tabs{display:flex;gap:6px;border-bottom:1px solid var(--gt-border);}
.dshgt-tab{appearance:none;border:none;background:none;padding:6px 10px;font:inherit;color:var(--gt-muted);cursor:pointer;border-bottom:2px solid transparent;}
.dshgt-tab[aria-selected="true"]{color:var(--gt-fg);border-bottom-color:var(--gt-accent);font-weight:600;}
.dshgt-shell{height:100%;min-height:0;overflow:hidden;}
.dshgt-content{flex:1;min-height:0;display:flex;}
.dshgt-scroll{flex:1;min-height:0;overflow-y:auto;display:flex;flex-direction:column;gap:12px;padding-right:4px;}
.dshgt-settings{flex:1;min-height:0;display:grid;grid-template-columns:150px minmax(0,1fr);gap:16px;}
.dshgt-vtabs{display:flex;flex-direction:column;gap:2px;border-right:1px solid var(--gt-border);padding-right:8px;overflow-y:auto;}
.dshgt-vtab{appearance:none;border:none;background:none;text-align:left;padding:7px 10px;border-radius:7px;color:var(--gt-muted);cursor:pointer;font:inherit;font-size:12px;display:flex;align-items:center;gap:6px;}
.dshgt-vtab:hover{background:var(--dsw-alias-interactive-bg-hover,color-mix(in srgb,var(--gt-accent) 8%,transparent));}
.dshgt-vtab[aria-selected="true"]{background:color-mix(in srgb,var(--gt-accent) 12%,transparent);color:var(--gt-fg);font-weight:600;}
.dshgt-vtab-dirty{width:6px;height:6px;border-radius:50%;background:var(--gt-warn);flex:none;margin-left:auto;}
.dshgt-vpanel{min-width:0;min-height:0;overflow-y:auto;display:flex;flex-direction:column;gap:12px;padding-right:4px;}
.dshgt-card{border:1px solid var(--gt-border);border-radius:10px;background:var(--gt-card);padding:12px 14px;display:flex;flex-direction:column;gap:8px;}
.dshgt-card-h{display:flex;align-items:center;gap:8px;flex-wrap:wrap;}
.dshgt-card-h h3{margin:0;font-size:13px;font-weight:600;}
.dshgt-hint{color:var(--gt-muted);font-size:12px;}
.dshgt-desc{margin:0;color:var(--gt-muted);font-size:12px;}
.dshgt-row{display:flex;gap:10px;align-items:center;min-height:28px;flex-wrap:wrap;}
.dshgt-row>label.dshgt-label{width:96px;color:var(--gt-muted);flex:none;font-size:12px;}
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
