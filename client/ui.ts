/**
 * 客户端与宿主的唯一接触点：只拿 `react`（其余宿主模块一概不 import）。
 * 组件用 `h()` 手写，避免在 `__ModuleLoader__` 的 CJS 包装里引入 jsx runtime 依赖。
 */
import React from 'react';

// 手写 createElement：把重载放宽成 any，避免每个组件都要为 children 写重载。
export const h: any = React.createElement;
export { React };

export interface ChildrenProps {
  children?: any;
  [key: string]: any;
}

/** 统一的根节点：所有页面都挂在 `.dshgt-root` 下，样式不泄漏到宿主。 */
export function Root(props: ChildrenProps): any {
  return h('div', { className: 'dshgt-root' }, props.children);
}

export function Card(props: ChildrenProps & { title: string; hint?: string; extra?: any }): any {
  const { title, hint, extra, children } = props;
  return h(
    'section',
    { className: 'dshgt-card' },
    h(
      'div',
      { className: 'dshgt-card-h' },
      h('h3', null, title),
      hint === undefined ? null : h('span', { className: 'dshgt-hint' }, hint),
      extra === undefined ? null : h('span', { style: { marginLeft: 'auto' } }, extra),
    ),
    children,
  );
}

export function Row(props: ChildrenProps & { label?: string }): any {
  return h(
    'div',
    { className: 'dshgt-row' },
    props.label === undefined ? null : h('label', { className: 'dshgt-label' }, props.label),
    props.children,
  );
}

export function Inline(props: ChildrenProps): any {
  return h('div', { className: 'dshgt-inline' }, props.children);
}

export function Input(props: ChildrenProps & { value?: string; onInput?: (value: string) => void; placeholder?: string; mono?: boolean; width?: number; password?: boolean }): any {
  const { value, onInput, placeholder, mono, width, password, ...rest } = props;
  return h('input', {
    ...rest,
    className: `dshgt-input${mono === true ? ' dshgt-mono' : ''}`,
    ...(width === undefined ? {} : { style: { width } }),
    ...(value === undefined ? {} : { value }),
    ...(placeholder === undefined ? {} : { placeholder }),
    ...(password === true ? { type: 'password' } : {}),
    onInput: (event: any) => onInput?.(event.target.value),
  });
}

export function TextArea(props: ChildrenProps & { value?: string; onInput?: (value: string) => void; rows?: number }): any {
  return h('textarea', {
    className: 'dshgt-input dshgt-mono',
    rows: props.rows ?? 3,
    value: props.value,
    onInput: (event: any) => props.onInput?.(event.target.value),
  });
}

export function Select(props: ChildrenProps & { value?: string; onChange?: (value: string) => void; options: Array<{ value: string; label: string }> }): any {
  return h(
    'select',
    {
      className: 'dshgt-select',
      value: props.value,
      onChange: (event: any) => props.onChange?.(event.target.value),
    },
    props.options.map((option) => h('option', { key: option.value, value: option.value }, option.label)),
  );
}

export function Btn(props: ChildrenProps & { onClick?: () => void; variant?: 'primary' | 'danger' | 'ghost'; small?: boolean; disabled?: boolean; title?: string }): any {
  const classes = ['dshgt-btn'];
  if (props.variant === 'primary') classes.push('dshgt-btn-primary');
  if (props.variant === 'danger') classes.push('dshgt-btn-danger');
  if (props.small === true) classes.push('dshgt-btn-sm');
  return h(
    'button',
    {
      type: 'button',
      className: classes.join(' '),
      onClick: props.onClick,
      disabled: props.disabled === true,
      ...(props.title === undefined ? {} : { title: props.title }),
    },
    props.children,
  );
}

export function Pill(props: { kind?: 'ok' | 'warn' | 'err' | 'idle'; children: any; mono?: boolean }): any {
  return h(
    'span',
    { className: `dshgt-pill${props.mono === true ? ' dshgt-mono' : ''}` },
    h('span', { className: `dshgt-dot ${props.kind ?? ''}`.trim() }),
    props.children,
  );
}

export function Alert(props: ChildrenProps & { kind?: 'ok' | 'warn' | 'err'; title?: string }): any {
  return h(
    'div',
    { className: `dshgt-alert${props.kind === 'err' ? ' err' : props.kind === 'ok' ? ' ok' : ''}` },
    props.title === undefined ? null : h('b', null, props.title),
    h('div', null, props.children),
  );
}

export function Toggle(props: { checked: boolean; onChange: (next: boolean) => void; label?: string }): any {
  return h(
    'label',
    { className: 'dshgt-inline', style: { gap: 6 } },
    h('button', {
      type: 'button',
      role: 'switch',
      className: 'dshgt-switch',
      'aria-checked': props.checked ? 'true' : 'false',
      onClick: () => props.onChange(!props.checked),
    }),
    props.label === undefined ? null : h('span', { className: 'dshgt-hint' }, props.label),
  );
}

export function Chips(props: { values: string[]; selected: string[]; onChange: (next: string[]) => void }): any {
  return h(
    'div',
    { className: 'dshgt-chips' },
    props.values.map((value) =>
      h(
        'button',
        {
          key: value,
          type: 'button',
          className: 'dshgt-chip',
          'aria-pressed': props.selected.includes(value) ? 'true' : 'false',
          onClick: () =>
            props.onChange(
              props.selected.includes(value) ? props.selected.filter((item) => item !== value) : [...props.selected, value],
            ),
        },
        value,
      ),
    ),
  );
}

export function KV(props: { items: Array<[string, any]> }): any {
  return h(
    'dl',
    { className: 'dshgt-kv' },
    props.items.flatMap(([key, value], index) => [h('dt', { key: `k${index}` }, key), h('dd', { key: `v${index}` }, value)]),
  );
}

export function duration(ms: number): string {
  if (ms <= 0) return '—';
  if (ms < 1000) return `${ms}ms`;
  return `${(ms / 1000).toFixed(1)}s`;
}

export function shortHash(hash: string | undefined): string {
  return typeof hash === 'string' && hash !== '' ? hash.slice(0, 10) : '—';
}

/** token 数量的展示：<1万原样千分位，≥1万用 k/M 缩略便于历史表紧凑。 */
export function formatTokens(value: number | undefined): string {
  if (value === undefined || !Number.isFinite(value)) return '—';
  if (value < 10_000) return value.toLocaleString('en-US');
  if (value < 1_000_000) return `${(value / 1000).toFixed(1)}k`.replace('.0k', 'k');
  return `${(value / 1_000_000).toFixed(1)}M`.replace('.0M', 'M');
}

export function localTime(iso: string | null | undefined): string {
  if (iso === null || iso === undefined) return '—';
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '—';
  return date.toLocaleString(undefined, {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hourCycle: 'h23',
  });
}

/** 复制失败不抛错：按钮只是便利动作，不阻塞任何流程。 */
export async function copyText(value: string): Promise<boolean> {
  try {
    if (typeof navigator === 'undefined' || navigator.clipboard === undefined) return false;
    await navigator.clipboard.writeText(value);
    return true;
  } catch {
    return false;
  }
}

/** 本地时间的「月-日 时:分」紧凑格式；用于运行列表。 */
export function shortTime(iso: string | null | undefined): string {
  if (iso === null || iso === undefined) return '—';
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '—';
  return date.toLocaleString(undefined, {
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  });
}
