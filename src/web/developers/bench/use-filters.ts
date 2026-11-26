import { useCallback, useEffect, useMemo, useState } from 'react';
import { filtersInUrl, setFiltersInUrl } from './url.ts';

export interface BenchFilters<K extends string> {
  /** The set filters, read from the query (`?status=4xx&key=…`). */
  values: Partial<Record<K, string>>;
  set: (key: K, value: string | null) => void;
  /** Every filter off; the search stays. */
  clear: () => void;
  /** How many filters are set, the search left out: the "Filters (n)" count and when Clear shows. */
  active: number;
}

const pick = <K extends string>(keys: readonly K[]): Partial<Record<K, string>> => {
  if (typeof location === 'undefined') return {};
  const all = filtersInUrl();
  return Object.fromEntries(keys.flatMap((k) => (all[k] ? [[k, all[k]]] : []))) as Partial<
    Record<K, string>
  >;
};

/**
 * A tool's filters as the address's query, so one link carries the view (`logs?status=4xx#id`).
 * Writes in place; Back and Forward (a tool switch) read them again. `search` names the key of the
 * search field: it is a filter in the address but not in the count.
 */
export function useBenchFilters<K extends string>(
  keys: readonly K[],
  { search }: { search?: K } = {},
): BenchFilters<K> {
  const signature = keys.join('|');
  // biome-ignore lint/correctness/useExhaustiveDependencies: `signature` stands for the keys' contents.
  const stable = useMemo(() => keys, [signature]);
  const [values, setValues] = useState(() => pick(stable));
  useEffect(() => {
    const read = () => setValues(pick(stable));
    addEventListener('popstate', read);
    return () => removeEventListener('popstate', read);
  }, [stable]);
  const set = useCallback((key: K, value: string | null) => {
    setFiltersInUrl({ [key]: value });
    setValues((v) => {
      const next = { ...v };
      if (value) next[key] = value;
      else delete next[key];
      return next;
    });
  }, []);
  const clear = useCallback(() => {
    const off = Object.fromEntries(stable.filter((k) => k !== search).map((k) => [k, null]));
    setFiltersInUrl(off);
    setValues((v) => (search && v[search] ? ({ [search]: v[search] } as typeof v) : {}));
  }, [stable, search]);
  const active = stable.filter((k) => k !== search && values[k]).length;
  return { values, set, clear, active };
}
