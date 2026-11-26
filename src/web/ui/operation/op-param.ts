import { useCallback, useState } from 'react';
import { wbToolOf } from '@/shared/workbench.ts';

const PARAM = 'op';

const read = (): string | null => {
  if (typeof window === 'undefined') return null;
  // On the Workbench Console `op` names an API operation (`?op=passes.getPasses`), not one of these.
  if (wbToolOf(window.location.pathname) === 'console') return null;
  const id = new URLSearchParams(window.location.search).get(PARAM);
  return id && id.length <= 64 ? id : null;
};

/**
 * The operation the URL names (`?op=<id>`), so a reload brings its sheet back. The router is not
 * involved: the param is written with `replaceState`, keeps every other param and the hash, and
 * leaves history alone. Read once on mount.
 */
export function useOperationParam(): [string | null, (id: string | null) => void] {
  const [id, setId] = useState(read);
  const set = useCallback((next: string | null) => {
    setId(next);
    try {
      const url = new URL(window.location.href);
      if (next) url.searchParams.set(PARAM, next);
      else url.searchParams.delete(PARAM);
      window.history.replaceState(window.history.state, '', url);
    } catch {
      // A sandboxed frame without history: the sheet still opens; a reload just starts clean.
    }
  }, []);
  return [id, set];
}
