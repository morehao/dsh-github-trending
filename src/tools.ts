/**
 * 两个对外工具：`trending_run` / `trending_history`（规格 §8）。
 *
 * 工具名是**稳定对外接口**：一旦发布不再改名；需要新能力时新增工具。
 * 参数方言用宿主 `dsh-tools` 的「内联 required: true」，输出用标准 JSON Schema。
 */
import { isPeriod } from './config.js';
import type { Runner } from './host/runner.js';
import type { Scheduler } from './host/schedule.js';
import type { RunRecord, Store } from './state.js';

const RUN_OUTPUT_SCHEMA = {
  type: 'object',
  additionalProperties: true,
  properties: {
    id: { type: 'string' },
    ok: { type: 'boolean' },
    skipped: { type: 'boolean' },
    dryRun: { type: 'boolean' },
    durationMs: { type: 'number' },
    coreVersion: { type: 'string' },
    files: { type: 'number' },
    contentHash: { type: 'string' },
    branch: { type: 'string' },
    prUrl: { type: 'string' },
    errorCode: { type: 'string' },
    errorMessage: { type: 'string' },
    errorHint: { type: 'string' },
    warnings: { type: 'array', items: { type: 'string' } },
    markdown: { type: 'string' },
  },
  required: ['ok', 'markdown'],
} as const;

const HISTORY_OUTPUT_SCHEMA = {
  type: 'object',
  additionalProperties: true,
  properties: {
    lastRunAt: { type: 'string' },
    nextRunAt: { type: 'string' },
    coreVersion: { type: 'string' },
    model: { type: 'string' },
    provider: { type: 'string' },
    pendingPr: { type: 'string' },
    records: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: true,
        properties: {
          at: { type: 'string' },
          ok: { type: 'boolean' },
          skipped: { type: 'boolean' },
          errorCode: { type: 'string' },
          durationMs: { type: 'number' },
          files: { type: 'number' },
          branch: { type: 'string' },
          prUrl: { type: 'string' },
          coreVersion: { type: 'string' },
        },
      },
    },
    markdown: { type: 'string' },
  },
  required: ['markdown'],
} as const;

function formatDuration(ms: number): string {
  if (ms <= 0) return '—';
  if (ms < 1000) return `${ms}ms`;
  return `${(ms / 1000).toFixed(1)}s`;
}

function describeRecord(record: RunRecord): string {
  const when = record.at.replace('T', ' ').slice(0, 19);
  const state = record.skipped ? '无变更' : record.ok ? '成功' : `失败 ${record.errorCode ?? ''}`.trim();
  const tail = [record.branch, record.prUrl].filter((item): item is string => typeof item === 'string' && item !== '').join(' · ');
  return `· ${when} ${state} · ${record.files} 个文件 · ${formatDuration(record.durationMs)}${tail === '' ? '' : ` · ${tail}`}`;
}

export function createTrendingRunTool(runner: Runner) {
  return {
    name: 'trending_run',
    description:
      '执行 GitHub 趋势榜单：定位并握手本地核心，spawn 核心 run，返回结构化摘要（文件数、commit、PR、错误码）。' +
      '省略 period 时默认产出日/周/月三榜（依次运行三次，返回 summaries）。' +
      'dryRun=true 只抓取与渲染、不写文件也不提交。同日同内容重跑会返回 skipped=true（零新增 commit）。',
    parameters: {
      dryRun: { type: 'boolean', description: '只试跑：不写文件、不提交、不开 PR' },
      date: { type: 'string', description: '指定日期（YYYY-MM-DD）；省略则用调度时区的今天' },
      period: { type: 'string', enum: ['daily', 'weekly', 'monthly'], description: '只跑指定周期；省略则默认产出日/周/月三榜' },
    },
    output: {
      schema: RUN_OUTPUT_SCHEMA,
      render: (_args: unknown, value: { markdown?: string }) => [{ type: 'text', text: typeof value?.markdown === 'string' ? value.markdown : '' }],
    },
    async execute(args: { dryRun?: boolean; date?: string; period?: string } = {}, exec: { signal?: AbortSignal } = {}) {
      void exec;
      const base = {
        dryRun: args.dryRun === true,
        ...(typeof args.date === 'string' && args.date !== '' ? { date: args.date } : {}),
        trigger: 'tool' as const,
      };
      // 显式指定单周期 → 只跑该周期；省略 → 手动运行默认产出日/周/月三榜。
      const summaries = isPeriod(args.period)
        ? [await runner.run({ ...base, period: args.period })]
        : await runner.runMany(base);
      const lines: string[] = [];
      for (const summary of summaries) {
        const periodLabel = summary.period ?? '—';
        const head = summary.ok ? (summary.skipped ? '无变更（skipped）' : summary.dryRun ? '试跑完成' : '运行成功') : `运行失败：${summary.error?.code ?? 'INTERNAL'}`;
        lines.push(`${summary.ok ? '✓' : '✗'} [${periodLabel}] ${head}`);
        lines.push(`· 核心 ${summary.coreVersion || '(未知)'} · ${formatDuration(summary.durationMs)} · ${summary.files} 个文件`);
        if (summary.tokens !== undefined) {
          const parts = [`本次 tokens ${summary.tokens.toLocaleString('en-US')}`];
          if (summary.releases !== undefined && summary.releases.enabled) {
            parts.push(`发版 ${summary.releases.newReleases} 个新版本 / ${summary.releases.repos} 个仓库`);
          }
          lines.push(`· ${parts.join(' · ')}`);
        }
        if (summary.contentHash !== undefined) lines.push(`· contentHash ${summary.contentHash.slice(0, 12)}`);
        if (summary.branch !== undefined) lines.push(`· 分支 ${summary.branch}`);
        if (summary.prUrl !== undefined) lines.push(`· PR ${summary.prUrl}`);
        if (summary.error !== undefined) {
          lines.push(`· ${summary.error.message}`);
          lines.push(`· 下一步：${summary.error.hint}`);
        }
      }
      if (summaries.length > 1) lines.push(`· 本次共跑 ${summaries.length} 个周期（日/周/月）`);
      if (summaries.some((summary) => summary.dryRun)) lines.push('· 这是试跑，没有写文件、没有提交');
      const ok = summaries.every((summary) => summary.ok);
      const primary = summaries[summaries.length - 1];
      return {
        ok,
        summaries: summaries.map((summary) => ({
          id: summary.id,
          period: summary.period,
          ok: summary.ok,
          skipped: summary.skipped,
          dryRun: summary.dryRun,
          durationMs: summary.durationMs,
          files: summary.files,
          ...(summary.tokens === undefined ? {} : { tokens: summary.tokens }),
          ...(summary.releases === undefined ? {} : { releases: summary.releases }),
          ...(summary.branch === undefined ? {} : { branch: summary.branch }),
          ...(summary.prUrl === undefined ? {} : { prUrl: summary.prUrl }),
          ...(summary.error === undefined ? {} : { errorCode: summary.error.code, errorMessage: summary.error.message }),
        })),
        id: primary?.id,
        skipped: summaries.every((summary) => summary.skipped),
        dryRun: base.dryRun,
        durationMs: summaries.reduce((sum, summary) => sum + summary.durationMs, 0),
        files: summaries.reduce((sum, summary) => sum + summary.files, 0),
        ...(() => {
          const total = summaries.reduce((sum, summary) => sum + (summary.tokens ?? 0), 0);
          return summaries.some((summary) => summary.tokens !== undefined) ? { tokens: total } : {};
        })(),
        warnings: summaries.flatMap((summary) => summary.warnings),
        ...(primary?.error === undefined
          ? {}
          : { errorCode: primary.error.code, errorMessage: primary.error.message, errorHint: primary.error.hint }),
        markdown: lines.join('\n'),
      };
    },
  };
}

export function createTrendingHistoryTool(store: Store, scheduler: Scheduler) {
  return {
    name: 'trending_history',
    description:
      '查看 GitHub 趋势日报的运行状态：上次/下次运行、最近 N 条记录（结果、耗时、commit/PR、错误码）、核心版本、当前模型与未合并 PR。',
    parameters: {
      limit: { type: 'number', description: '返回最近多少条记录（默认 10，最多 30）' },
    },
    output: {
      schema: HISTORY_OUTPUT_SCHEMA,
      render: (_args: unknown, value: { markdown?: string }) => [{ type: 'text', text: typeof value?.markdown === 'string' ? value.markdown : '' }],
    },
    async execute(args: { limit?: number } = {}) {
      const limit = Math.min(Math.max(Math.round(Number(args.limit ?? 10)) || 10, 1), 30);
      const settings = store.readSettings();
      const state = store.readState();
      const records = store.readHistory().slice(0, limit);
      const schedule = scheduler.describe(state);
      const lines: string[] = [];
      lines.push(`上次运行：${state.lastRunAt === undefined ? '从未' : state.lastRunAt.replace('T', ' ').slice(0, 19)}`);
      lines.push(`下次运行：${schedule.nextRunAt === undefined ? '未启用' : `${schedule.nextRunAt.replace('T', ' ').slice(0, 16)} UTC（${schedule.time} ${schedule.timezone}）`}`);
      lines.push(`核心版本：${state.lastResult?.coreVersion ?? '(尚未运行)'}`);
      lines.push(`模型：${settings.model.provider} / ${settings.model.model || '(未填)'} · ${settings.model.mode === 'proxy' ? '回环代理' : `凭据 ${settings.model.apiKeyRef}`}`);
      if (state.pendingPr !== undefined) lines.push(`未合并 PR：${state.pendingPr.url}`);
      if (state.lastDigest !== undefined) {
        lines.push(`上次内容：${state.lastDigest.date} · ${state.lastDigest.contentHash.slice(0, 12)} · 核心 ${state.lastDigest.coreVersion}`);
      }
      lines.push(`最近 ${records.length} 次：`);
      if (records.length === 0) lines.push('· 还没有运行记录');
      for (const record of records) lines.push(describeRecord(record));
      return {
        ...(state.lastRunAt === undefined ? {} : { lastRunAt: state.lastRunAt }),
        ...(schedule.nextRunAt === undefined ? {} : { nextRunAt: schedule.nextRunAt }),
        coreVersion: state.lastResult?.coreVersion ?? '',
        model: settings.model.model,
        provider: settings.model.provider,
        ...(state.pendingPr === undefined ? {} : { pendingPr: state.pendingPr.url }),
        records,
        markdown: lines.join('\n'),
      };
    },
  };
}
