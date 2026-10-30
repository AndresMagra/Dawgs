import { useCallback, useEffect, useRef, useState } from 'react';

/**
 * Load something from the API, with reload and an error to show.
 * Re-runs when `deps` change; `poll` keeps a live screen (the board, a
 * running walk) fresh without a socket.
 */
export function useLoad<T>(fn: () => Promise<T>, deps: unknown[] = [], poll?: number) {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const live = useRef(true);
  const reload = useCallback(async () => {
    setLoading(true);
    try {
      const d = await fn();
      if (live.current) {
        setData(d);
        setError(null);
      }
    } catch (e) {
      if (live.current) setError((e as Error).message);
    } finally {
      if (live.current) setLoading(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);
  useEffect(() => {
    live.current = true;
    void reload();
    const id = poll ? setInterval(() => void reload(), poll) : null;
    return () => {
      live.current = false;
      if (id) clearInterval(id);
    };
  }, [reload, poll]);
  return { data, error, loading, reload, setData };
}
