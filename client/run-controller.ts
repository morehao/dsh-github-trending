/**
 * 运行控制器：外壳、概览、运行记录共用一个 `POST /run`，避免重复触发。
 *
 * 运行结果仍以 `/state` 刷新的历史为准；这里的 `summary` 只用于立即反馈错误。
 * `running` 同时看服务端快照与本地请求中状态：点下按钮到 Host 记下 running 之间
 * 有一小段窗口，不能让按钮在这段时间里可重复点击。
 */
import { React } from './ui.js';
import { apiCall, type Period, type RunSummary } from './api.js';
import type { StoreValue } from './store.js';

export interface RunOptions {
  /** 强制重跑：忽略摘要缓存、重新生成。仅手动入口使用。 */
  force?: boolean;
  /** 指定日期（YYYY-MM-DD）；省略则用调度时区的今天。 */
  date?: string;
  /** 只跑指定周期；省略则跑日/周/月三榜。 */
  period?: Period;
}

export interface RunController {
  running: boolean;
  busy: boolean;
  error: string | null;
  summary: RunSummary | null;
  startedAt: string | null;
  dryRun: boolean;
  setDryRun: (next: boolean) => void;
  run: (dryRun?: boolean, options?: RunOptions) => Promise<void>;
  cancel: () => Promise<void>;
  clearError: () => void;
}

export function useRunController(store: StoreValue): RunController {
  const { refresh } = store;
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const [summary, setSummary] = React.useState<RunSummary | null>(null);
  const [dryRun, setDryRun] = React.useState(false);
  const [localStartedAt, setLocalStartedAt] = React.useState<string | null>(null);

  const run = React.useCallback(
    async (overrideDry?: boolean, options?: RunOptions): Promise<void> => {
      const dry = overrideDry ?? dryRun;
      setBusy(true);
      setError(null);
      setSummary(null);
      setLocalStartedAt(new Date().toISOString());
      try {
        const body: Record<string, unknown> = { dryRun: dry };
        if (options?.force === true) body.force = true;
        if (options?.date !== undefined && options.date !== '') body.date = options.date;
        if (options?.period !== undefined) body.period = options.period;
        const result = await apiCall<{ summary: RunSummary }>('POST', '/run', body);
        setSummary(result.summary);
        await refresh({ quiet: true });
      } catch (failure) {
        setError(failure instanceof Error ? failure.message : String(failure));
      } finally {
        setBusy(false);
        setLocalStartedAt(null);
      }
    },
    [dryRun, refresh],
  );

  const cancel = React.useCallback(async (): Promise<void> => {
    setError(null);
    try {
      await apiCall('POST', '/run/cancel', {});
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : String(failure));
    } finally {
      await refresh({ quiet: true });
    }
  }, [refresh]);

  const serverRunning = store.state?.status.running ?? null;
  return {
    running: serverRunning !== null || busy,
    busy,
    error,
    summary,
    startedAt: serverRunning?.startedAt ?? localStartedAt,
    dryRun,
    setDryRun,
    run,
    cancel,
    clearError: () => setError(null),
  };
}

/** 运行中每秒刷新一次已用时；不轮询 Host。 */
export function useElapsed(startedAt: string | null | undefined, active: boolean): number {
  const [now, setNow] = React.useState(() => Date.now());
  React.useEffect(() => {
    if (!active) return () => undefined;
    setNow(Date.now());
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [active]);
  if (startedAt === null || startedAt === undefined) return 0;
  const started = new Date(startedAt).getTime();
  if (Number.isNaN(started)) return 0;
  return Math.max(0, now - started);
}

export function formatElapsed(ms: number): string {
  const total = Math.floor(ms / 1000);
  const minutes = Math.floor(total / 60);
  const seconds = total % 60;
  return `${minutes}:${String(seconds).padStart(2, '0')}`;
}
