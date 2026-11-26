import { useCallback, useState } from 'react';

const PARAM = 'op';

const read = (name: string): string | null => {
  if (typeof window === 'undefined') return null;
  const id = new URLSearchParams(window.location.search).get(name);
  return id && id.length <= 64 ? id : null;
};

/**
 * The operation the URL names (`?op=<id>`), so a reload brings its sheet back. The router is not
 * involved: the param is written with `replaceState`, keeps every other param and the hash, and
 * leaves history alone. Read once on mount. The tray opens its sheet for `op`; a panel drawn inline on the page
 * keeps its own `name`, so a reload does not open the same operation twice.
 */
export function useOperationParam(
  name: string = PARAM,
): [string | null, (id: string | null) => void] {
  const [id, setId] = useState(() => read(name));
  const set = useCallback(
    (next: string | null) => {
      setId(next);
      try {
        const url = new URL(window.location.href);
        if (next) url.searchParams.set(name, next);
        else url.searchParams.delete(name);
        window.history.replaceState(window.history.state, '', url);
      } catch {
        // A sandboxed frame without history: the sheet still opens; a reload just starts clean.
      }
    },
    [name],
  );
  return [id, set];
}
