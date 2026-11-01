import type { Range } from './range.ts';

export interface OverviewSearch {
  range?: Range | undefined;
}

export function parseOverviewSearch(raw: Record<string, unknown>): OverviewSearch {
  return {
    range: raw.range === '24h' || raw.range === '30d' || raw.range === '7d' ? raw.range : undefined,
  };
}
