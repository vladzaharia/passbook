import type { Range } from './range.ts';

export interface OverviewSearch {
  /** Platform display filter, never a tenant scope: the admin route does not retain it. */
  filterOrgId?: string | undefined;
  range?: Range | undefined;
}

export function parseOverviewSearch(raw: Record<string, unknown>): OverviewSearch {
  return {
    filterOrgId:
      typeof raw.filterOrgId === 'string' && raw.filterOrgId.trim()
        ? raw.filterOrgId.trim()
        : undefined,
    range: raw.range === '24h' || raw.range === '30d' || raw.range === '7d' ? raw.range : undefined,
  };
}
