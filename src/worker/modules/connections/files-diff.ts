import type { StoredRef } from './files-store.ts';

export interface FileDiff {
  added: number;
  changed: number;
  removed: number;
  examples: { added: string[]; changed: string[]; removed: string[] };
}

const EXAMPLES = 5;

/** Refs and digests of a new revision against the one it would replace; both lists are sorted by ref. */
export function diffRefs(before: readonly StoredRef[], after: readonly StoredRef[]): FileDiff {
  const out: FileDiff = {
    added: 0,
    changed: 0,
    removed: 0,
    examples: { added: [], changed: [], removed: [] },
  };
  const note = (kind: 'added' | 'changed' | 'removed', ref: string) => {
    out[kind]++;
    if (out.examples[kind].length < EXAMPLES) out.examples[kind].push(ref);
  };
  let i = 0;
  let j = 0;
  while (i < before.length || j < after.length) {
    const a = before[i];
    const b = after[j];
    if (a && b && a.ref === b.ref) {
      if (a.digest !== b.digest) note('changed', b.ref);
      i++;
      j++;
    } else if (b && (!a || b.ref < a.ref)) {
      note('added', b.ref);
      j++;
    } else if (a) {
      note('removed', a.ref);
      i++;
    }
  }
  return out;
}
