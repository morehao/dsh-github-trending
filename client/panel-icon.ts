/**
 * 侧栏入口图标（趋势折线）。
 *
 * 宿主把 `sidebar.panellist` 注册的组件渲染进导航行按钮里的 16–18px glyph
 * （`span.panelGlyph`），并通过 props 传入 `size`（宽/窄栏不同）与 `active`
 * （是否当前选中）。所以这里只能画一个自包含的小图标，不能放卡片——
 * 往这里塞整块 UI 会撑满整个侧栏（v0.1.4 的已知问题）。
 *
 * 只允许 `react`；不 import 宿主图标库，颜色走 `currentColor` 跟随行文本色。
 */
import { h } from './ui.js';

/** 折线图标的几何。 */
const TREND_LINE = '3 16.5 9 10.5 13 14.5 21 6.5';
/** 折线末端的箭头。 */
const TREND_ARROW = '15.5 6.5 21 6.5 21 12';

export function SidebarPanelIcon(props: { size?: number; active?: boolean }): any {
  const size = typeof props.size === 'number' ? props.size : 16;
  return h(
    'svg',
    {
      width: size,
      height: size,
      viewBox: '0 0 24 24',
      fill: 'none',
      stroke: 'currentColor',
      strokeWidth: props.active === true ? 2 : 1.7,
      strokeLinecap: 'round',
      strokeLinejoin: 'round',
      'aria-hidden': 'true',
      focusable: 'false',
    },
    h('polyline', { points: TREND_LINE }),
    h('polyline', { points: TREND_ARROW }),
  );
}
