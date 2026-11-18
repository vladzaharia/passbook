import { ValidationError } from '../../platform/errors.ts';

/** A root is depth 0; a zone may sit up to three levels below it. */
export const MAX_ZONE_DEPTH = 3;

export interface ZoneNode {
  id: string;
  parentId: string | null;
  timeZone: string | null;
  sort: number;
  name: string;
}

export type ZoneIndex = ReadonlyMap<string, ZoneNode>;

export const indexZones = (rows: readonly ZoneNode[]): ZoneIndex =>
  new Map(rows.map((r) => [r.id, r]));

/** Ancestors from the zone's parent up to its root. A broken chain stops at the gap. */
function ancestors(index: ZoneIndex, id: string): ZoneNode[] {
  const out: ZoneNode[] = [];
  const seen = new Set([id]);
  let at = index.get(id)?.parentId ?? null;
  while (at !== null && !seen.has(at)) {
    const node = index.get(at);
    if (!node) break;
    out.push(node);
    seen.add(at);
    at = node.parentId;
  }
  return out;
}

export const depthOf = (index: ZoneIndex, id: string): number => ancestors(index, id).length;

/** The root's time zone, or null. */
export function effectiveTimeZone(index: ZoneIndex, id: string): string | null {
  const own = index.get(id);
  if (!own) return null;
  return own.timeZone ?? ancestors(index, id).find((a) => a.timeZone !== null)?.timeZone ?? null;
}

/** The zone and every zone below it, parents first. */
export function subtree(index: ZoneIndex, id: string): ZoneNode[] {
  const children = new Map<string, ZoneNode[]>();
  for (const n of index.values())
    if (n.parentId !== null) children.set(n.parentId, [...(children.get(n.parentId) ?? []), n]);
  const root = index.get(id);
  if (!root) return [];
  const out: ZoneNode[] = [];
  const walk = (n: ZoneNode) => {
    out.push(n);
    for (const c of children.get(n.id) ?? []) walk(c);
  };
  walk(root);
  return out;
}

const height = (index: ZoneIndex, id: string): number => {
  const rootDepth = depthOf(index, id);
  return Math.max(...subtree(index, id).map((n) => depthOf(index, n.id) - rootDepth), 0);
};

/**
 * The zone, placed under `parentId`, must not be inside its own subtree (`ZONE_CYCLE`) and
 * must leave every zone below it within the depth limit (`ZONE_DEPTH`). `id` may be new.
 */
export function assertPlacement(index: ZoneIndex, id: string, parentId: string | null): void {
  if (parentId === null) return;
  if (subtree(index, id).some((n) => n.id === parentId))
    throw new ValidationError('A zone cannot sit inside itself.', [], 'ZONE_CYCLE');
  const own = index.has(id) ? height(index, id) : 0;
  if (depthOf(index, parentId) + 1 + own > MAX_ZONE_DEPTH)
    throw new ValidationError('Zones nest three levels deep at most.', [], 'ZONE_DEPTH');
}

/** The tree in display order: roots, then each zone's children, by sort then name. */
export function treeOrder<T extends ZoneNode>(rows: readonly T[]): T[] {
  const byParent = new Map<string | null, T[]>();
  const ids = new Set(rows.map((r) => r.id));
  for (const r of rows) {
    // A child whose parent is not in the set (a filtered list) is shown as a root.
    const key = r.parentId !== null && ids.has(r.parentId) ? r.parentId : null;
    byParent.set(key, [...(byParent.get(key) ?? []), r]);
  }
  const order = (a: T, b: T) =>
    a.sort - b.sort || a.name.localeCompare(b.name) || a.id.localeCompare(b.id);
  const out: T[] = [];
  const walk = (key: string | null) => {
    for (const r of (byParent.get(key) ?? []).sort(order)) {
      out.push(r);
      walk(r.id);
    }
  };
  walk(null);
  return out;
}
