/**
 * The bench's address grammar: `/developers/<tool>?<filters>#<id>`. The selection is the hash and the
 * filters are the query, so one link carries both. Both write in place (`replaceState`): Back and
 * Forward step through tool switches, not through every row picked or filter set.
 */

/** The selected item's id, or null. A tail after `?` is the tool's own (the console's prefill), not the id. */
export function selectedId(hash: string = location.hash): string | null {
  const raw = hash.replace(/^#/, '');
  const id = decodeURIComponent(raw.split('?')[0] ?? '');
  return id === '' ? null : id;
}

const write = (url: URL) => history.replaceState(history.state, '', url);

/** Selects `id` in the address, or clears the selection; the filters stay. */
export function selectInUrl(id: string | null): void {
  const url = new URL(location.href);
  url.hash = id === null ? '' : encodeURIComponent(id);
  write(url);
}

/** The filters set in the address. */
export function filtersInUrl(search: string = location.search): Record<string, string> {
  return Object.fromEntries(new URLSearchParams(search));
}

/** Sets or clears filters (null or '' clears one); the others and the selection stay. */
export function setFiltersInUrl(next: Record<string, string | null | undefined>): void {
  const url = new URL(location.href);
  for (const [k, v] of Object.entries(next)) {
    if (v === null || v === undefined || v === '') url.searchParams.delete(k);
    else url.searchParams.set(k, v);
  }
  write(url);
}
