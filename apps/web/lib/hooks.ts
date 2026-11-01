'use client';
import { useCallback, useEffect, useRef, useState } from 'react';
import { ApiError, gql, pollingPaused } from './api';

/** Small data hook: loading / error / data / refetch. */
export function useQuery<T>(query: string, variables?: Record<string, unknown>, opts: { skip?: boolean; pollMs?: number } = {}) {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<ApiError | null>(null);
  const [loading, setLoading] = useState(!opts.skip);
  const vars = JSON.stringify(variables ?? {});
  const alive = useRef(true);

  const refetch = useCallback(async () => {
    try {
      const d = await gql<T>(query, JSON.parse(vars));
      if (alive.current) {
        setData(d);
        setError(null);
      }
      return d;
    } catch (e) {
      if (alive.current) setError(e as ApiError);
      return null;
    } finally {
      if (alive.current) setLoading(false);
    }
  }, [query, vars]);

  useEffect(() => {
    alive.current = true;
    if (opts.skip) return;
    setLoading(true);
    void refetch();
    if (!opts.pollMs) return () => { alive.current = false; };
    // Poll only while the tab is visible and the API isn't asking us to slow down; catch up when it's back.
    const t = setInterval(() => { if (!document.hidden && !pollingPaused()) void refetch(); }, opts.pollMs);
    const onVisible = () => { if (!document.hidden && !pollingPaused()) void refetch(); };
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      alive.current = false;
      clearInterval(t);
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, [refetch, opts.skip, opts.pollMs]);

  return { data, error, loading, refetch, setData };
}

/** Mutation helper that exposes pending state and a user-readable error. */
export function useMutation<T = any>(query: string) {
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const run = useCallback(
    async (variables?: Record<string, unknown>): Promise<T | null> => {
      setPending(true);
      setError(null);
      try {
        return await gql<T>(query, variables);
      } catch (e) {
        const err = e as ApiError;
        if (err.code !== 'CANCELLED') setError(err.message);
        return null;
      } finally {
        setPending(false);
      }
    },
    [query],
  );
  return { run, pending, error, setError };
}
