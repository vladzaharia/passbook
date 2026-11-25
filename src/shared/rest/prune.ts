import { escapeToken } from '../records/fields.ts';

export interface PruneLimits {
  items: number;
  string: number;
  depth: number;
  nodes: number;
}

export const PROBE_LIMITS: PruneLimits = { items: 25, string: 500, depth: 12, nodes: 20_000 };
const MAX_ARRAY_NOTES = 500;
/** The contract's pointer limit (JsonPointerSchema): a longer pointer is left out, not cut. */
export const MAX_POINTER = 500;

export interface Pruned {
  arrays: { pointer: string; total: number; shown: number }[];
  strings: number;
  depthCut: boolean;
  nodesCut: boolean;
}

/**
 * A JSON document cut to what the explorer can show, in one walk that never goes deeper than `limits.depth`:
 * long arrays and strings, deep levels and extra nodes drop out, and keys are cut like strings. `mask` sees each
 * whole string and key before it is cut, so no part of a longer value escapes it. Notes whose pointer would pass
 * the contract limit are left out.
 */
export function prune(
  root: unknown,
  limits: PruneLimits = PROBE_LIMITS,
  mask: (text: string) => string = (t) => t,
): { value: unknown; pruned: Pruned } {
  const pruned: Pruned = { arrays: [], strings: 0, depthCut: false, nodesCut: false };
  let nodes = 0;
  const cut = (text: string, count: boolean): string => {
    const masked = mask(text);
    if (masked.length <= limits.string) return masked;
    if (count) pruned.strings++;
    return `${masked.slice(0, limits.string)}…`;
  };
  const walk = (value: unknown, pointer: string | null, depth: number): unknown => {
    if (typeof value === 'string') return cut(value, true);
    if (typeof value === 'number') return mask(String(value)) === String(value) ? value : '***';
    if (typeof value !== 'object' || value === null) return value;
    if (depth >= limits.depth) {
      pruned.depthCut = true;
      return null;
    }
    if (Array.isArray(value)) {
      const shown = Math.min(value.length, limits.items);
      if (shown < value.length && pointer !== null && pruned.arrays.length < MAX_ARRAY_NOTES)
        pruned.arrays.push({ pointer, total: value.length, shown });
      const out: unknown[] = [];
      for (let i = 0; i < shown; i++) {
        if (++nodes > limits.nodes) {
          pruned.nodesCut = true;
          break;
        }
        out.push(walk(value[i], pointer === null ? null : `${pointer}/${i}`, depth + 1));
      }
      return out;
    }
    const out: Record<string, unknown> = {};
    for (const key in value) {
      if (!Object.hasOwn(value, key)) continue;
      if (++nodes > limits.nodes) {
        pruned.nodesCut = true;
        break;
      }
      const shownKey = cut(key, false);
      const child = pointer === null ? null : `${pointer}/${escapeToken(shownKey)}`;
      out[shownKey] = walk(
        (value as Record<string, unknown>)[key],
        child !== null && child.length <= MAX_POINTER ? child : null,
        depth + 1,
      );
    }
    return out;
  };
  return { value: walk(root, '', 0), pruned };
}
