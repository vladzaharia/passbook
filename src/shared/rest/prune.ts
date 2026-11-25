import { escapeToken } from '../records/fields.ts';

export interface PruneLimits {
  items: number;
  string: number;
  depth: number;
  nodes: number;
}

export const PROBE_LIMITS: PruneLimits = { items: 25, string: 500, depth: 12, nodes: 20_000 };
const MAX_ARRAY_NOTES = 500;

export interface Pruned {
  arrays: { pointer: string; total: number; shown: number }[];
  strings: number;
  depthCut: boolean;
  nodesCut: boolean;
}

/** A JSON document cut to what the explorer can show: long arrays and strings, deep levels and extra nodes drop out. */
export function prune(
  root: unknown,
  limits: PruneLimits = PROBE_LIMITS,
): { value: unknown; pruned: Pruned } {
  const pruned: Pruned = { arrays: [], strings: 0, depthCut: false, nodesCut: false };
  let nodes = 0;
  const walk = (value: unknown, pointer: string, depth: number): unknown => {
    if (typeof value === 'string') {
      if (value.length <= limits.string) return value;
      pruned.strings++;
      return `${value.slice(0, limits.string)}…`;
    }
    if (typeof value !== 'object' || value === null) return value;
    if (depth >= limits.depth) {
      pruned.depthCut = true;
      return null;
    }
    if (Array.isArray(value)) {
      const shown = Math.min(value.length, limits.items);
      if (shown < value.length && pruned.arrays.length < MAX_ARRAY_NOTES)
        pruned.arrays.push({ pointer, total: value.length, shown });
      const out: unknown[] = [];
      for (let i = 0; i < shown; i++) {
        if (++nodes > limits.nodes) {
          pruned.nodesCut = true;
          break;
        }
        out.push(walk(value[i], `${pointer}/${i}`, depth + 1));
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
      const child = (value as Record<string, unknown>)[key];
      out[key] = walk(child, `${pointer}/${escapeToken(key)}`, depth + 1);
    }
    return out;
  };
  return { value: walk(root, '', 0), pruned };
}
