import type { ScanZone } from '@/shared/contracts/scan-access.ts';

export interface ZoneNode {
  zone: ScanZone;
  /** 1 for a root (the `aria-level`). */
  level: number;
  /** Names from the root down to the parent. */
  path: string[];
  /** Zones below this one, all depths. */
  below: number;
}

const bySort = (a: ScanZone, b: ScanZone) => a.sort - b.sort || a.name.localeCompare(b.name);

/**
 * Zones in tree order: each root, then its children, depth first. A zone whose parent is not in
 * the list (an archived parent) is shown as a root so it is never lost.
 */
export function zoneNodes(zones: readonly ScanZone[]): ZoneNode[] {
  const ids = new Set(zones.map((z) => z.id));
  const kids = new Map<string | null, ScanZone[]>();
  for (const zone of zones) {
    const parent = zone.parentId && ids.has(zone.parentId) ? zone.parentId : null;
    kids.set(parent, [...(kids.get(parent) ?? []), zone]);
  }
  const out: ZoneNode[] = [];
  const walk = (parent: string | null, level: number, path: string[]): number => {
    let count = 0;
    for (const zone of (kids.get(parent) ?? []).sort(bySort)) {
      const node: ZoneNode = { zone, level, path, below: 0 };
      out.push(node);
      node.below = walk(zone.id, level + 1, [...path, zone.name]);
      count += 1 + node.below;
    }
    return count;
  };
  walk(null, 1, []);
  return out;
}

/** Roots may hold three more levels: depth 0..3. */
export const MAX_DEPTH = 3;
