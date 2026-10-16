import { useEffect, useRef, useState } from 'react';
import type { Api } from './api.js';
export function useQuery<T>(request: Api, endpoint: string, payload: unknown, enabled = true, isActive?: (data: T) => boolean, poll = true) {
  const [data, setData] = useState<T>();
  const [error, setError] = useState('');
  const [generation, setGeneration] = useState(0);
  const active = useRef(isActive); active.current = isActive;
  const key = JSON.stringify(payload);
  useEffect(() => {
    setData(undefined); setError('');
    if (!enabled) return;
    let stopped = false; let serial = 0; let timer: ReturnType<typeof setTimeout> | undefined; let control: AbortController | undefined;
    async function load() {
      if (stopped || document.hidden) return;
      clearTimeout(timer); control?.abort(); control = new AbortController(); const ticket = ++serial;
      let delay = 5000;
      try {
        const value = await request<T>(endpoint, JSON.parse(key), control.signal);
        if (stopped || ticket !== serial) return;
        setData(value); setError('');
        if (active.current?.(value)) delay = 1000;
      } catch (cause) {
        if (stopped || ticket !== serial || control.signal.aborted) return;
        setError(cause instanceof Error ? cause.message : 'Observation query failed');
        return;
      }
      if (!stopped && poll) timer = setTimeout(() => { void load(); }, delay);
    }
    const visibility = () => {
      ++serial; clearTimeout(timer); control?.abort();
      if (!document.hidden) void load();
    };
    document.addEventListener('visibilitychange', visibility);
    window.addEventListener('dsh-observe-reconnect', visibility);
    void load();
    return () => { stopped = true; ++serial; clearTimeout(timer); control?.abort(); document.removeEventListener('visibilitychange', visibility); window.removeEventListener('dsh-observe-reconnect', visibility); };
  }, [request, endpoint, key, enabled, generation, poll]);
  return { data, error, refresh: () => setGeneration((value) => value + 1) };
}
