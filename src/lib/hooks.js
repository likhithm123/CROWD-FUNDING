import { useCallback, useEffect, useRef, useState } from 'react';
import { api } from './api';

/** Fetch `path` and expose { data, error, loading, reload }. */
export function useApi(path, { keepPrevious = false } = {}) {
  const [state, setState] = useState({ data: null, error: null, loading: true });
  const current = useRef(path);
  current.current = path;

  const load = useCallback(async () => {
    if (!path) return;
    // Keep the old data only when reloading the same address; a new address starts blank
    // so nothing from the previous page (e.g. another project) is shown or reused.
    setState((s) => (s.path === path || keepPrevious ? { ...s, loading: true, error: null } : { data: null, error: null, loading: true, path }));
    try {
      const data = await api.get(path);
      if (current.current === path) setState({ data, error: null, loading: false, path });
    } catch (error) {
      if (current.current === path) setState({ data: null, error, loading: false, path });
    }
  }, [path, keepPrevious]);

  useEffect(() => { load(); }, [load]);
  return { ...state, reload: load };
}
