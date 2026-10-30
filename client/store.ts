/**
 * 共享状态：一个 `/state` 快照 + 轮询。
 *
 * 轮询而不是推送：宿主没有给第三方插件的通用事件总线，5 s 一次的本地请求比
 * 自己造 SSE 简单，也够用（运行中的进度本来就是粗粒度的）。
 */
import { React } from './ui.js';
import { apiCall, type StatePayload } from './api.js';

const POLL_MS = 5000;

export interface StoreValue {
  state: StatePayload | null;
  error: string | null;
  loading: boolean;
  refresh: (options?: { quiet?: boolean }) => Promise<void>;
}

export function useStore(): StoreValue {
  const [state, setState] = React.useState<StatePayload | null>(null);
  const [error, setError] = React.useState<string | null>(null);
  const [loading, setLoading] = React.useState(true);
  const mounted = React.useRef(true);

  const refresh = React.useCallback(async (options: { quiet?: boolean } = {}): Promise<void> => {
    if (options.quiet !== true) setLoading(true);
    try {
      const payload = await apiCall<StatePayload>('GET', '/state');
      if (!mounted.current) return;
      setState(payload);
      setError(null);
    } catch (failure) {
      if (!mounted.current) return;
      setError(failure instanceof Error ? failure.message : String(failure));
    } finally {
      if (mounted.current) setLoading(false);
    }
  }, []);

  React.useEffect(() => {
    mounted.current = true;
    void refresh();
    const timer = setInterval(() => void refresh({ quiet: true }), POLL_MS);
    return () => {
      mounted.current = false;
      clearInterval(timer);
    };
  }, [refresh]);

  return { state, error, loading, refresh };
}
