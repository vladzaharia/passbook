import type { SortingState } from '@tanstack/react-table';

/** "name" = ascending, "-name" = descending. Stable and short for query strings. */
export function sortingToParam(sorting: SortingState): string | undefined {
  const first = sorting[0];
  if (!first) return undefined;
  return first.desc ? `-${first.id}` : first.id;
}

export function sortingFromParam(param: string | undefined | null): SortingState {
  if (!param) return [];
  return param.startsWith('-') ? [{ id: param.slice(1), desc: true }] : [{ id: param, desc: false }];
}

/** Drops empty values so URLs stay clean when a filter is cleared. */
export function compactSearch<T extends Record<string, unknown>>(search: T): Partial<T> {
  const out: Partial<T> = {};
  for (const [key, value] of Object.entries(search)) {
    if (value === undefined || value === null || value === '') continue;
    (out as Record<string, unknown>)[key] = value;
  }
  return out;
}
