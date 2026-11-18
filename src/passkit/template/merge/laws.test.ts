import { describe, expect, it } from 'vitest';
import { applyResolutions, mergePackages } from './apply.ts';
import { mutate, rng } from './laws-test-fixtures.ts';
import { baseDoc, edit, lostEdits } from './merge-test-fixtures.ts';
import { normalize } from './normalize.ts';
import type { PackageDoc, Resolution } from './types.ts';

const SEEDS = Array.from({ length: 200 }, (_, i) => i + 1);
const ids = (b: PackageDoc, o: PackageDoc, t: PackageDoc) =>
  mergePackages(b, o, t).conflicts.map((c) => c.id);
/** pass.json and the manifest as bytes: key order counts. Files are sorted by name by design. */
const bytes = (d: PackageDoc) => JSON.stringify([d.passJson, d.manifest]);

/** A deep copy with every object's keys in reverse order. */
const reversed = <T>(v: T): T =>
  Array.isArray(v)
    ? (v.map(reversed) as T)
    : v && typeof v === 'object' && !(v instanceof Uint8Array)
      ? (Object.fromEntries(
          Object.entries(v)
            .reverse()
            .map(([k, x]) => [k, reversed(x)]),
        ) as T)
      : v;

describe('merge laws', () => {
  // Two barcodes, so either side can remove one at either index.
  const base = edit(baseDoc(), (d) =>
    d.passJson.barcodes.push({
      format: 'PKBarcodeFormatAztec',
      message: 'z',
      messageEncoding: 'x',
    }),
  );
  const each = (fn: (o: PackageDoc, t: PackageDoc, seed: number) => void) => {
    for (const seed of SEEDS) {
      const r = rng(seed);
      fn(mutate(base, r, 1 + Math.floor(r() * 5)), mutate(base, r, 1 + Math.floor(r() * 5)), seed);
    }
  };

  it('merge(b, x, x) = x, byte for byte', () => {
    each((x, _, seed) => {
      const r = mergePackages(base, x, x);
      expect(r.status, `seed ${seed}`).toBe('clean');
      expect(bytes(r.merged), `seed ${seed}`).toBe(bytes(normalize(x)));
      expect(r.merged.files).toEqual(normalize(x).files);
    });
  });
  it('merge(b, b, t) = t and merge(b, o, b) = o, clean and byte for byte', () => {
    each((o, t, seed) => {
      const ff = mergePackages(base, base, t);
      expect([ff.status, bytes(ff.merged)], `seed ${seed}`).toEqual(['clean', bytes(normalize(t))]);
      const kept = mergePackages(base, o, base);
      expect([kept.status, bytes(kept.merged)], `seed ${seed}`).toEqual([
        'clean',
        bytes(normalize(o)),
      ]);
      expect(kept.theirs).toEqual([]);
    });
  });
  it('no lost edit: a clean merge has every edit of either side', () => {
    let clean = 0;
    each((o, t, seed) => {
      const m = mergePackages(base, o, t);
      if (m.status !== 'clean') return;
      clean++;
      expect(lostEdits(base, o, m.merged), `ours, seed ${seed}`).toEqual([]);
      expect(lostEdits(base, t, m.merged), `theirs, seed ${seed}`).toEqual([]);
    });
    expect(clean).toBeGreaterThan(SEEDS.length / 5);
  });
  it('no lost edit: a conflicted merge is provisionally ours and keeps every ours edit', () => {
    each((o, t, seed) => {
      expect(lostEdits(base, o, mergePackages(base, o, t).merged), `seed ${seed}`).toEqual([]);
    });
  });
  it('a result never has two main styles, under any side picked', () => {
    const MAIN = ['generic', 'storeCard', 'coupon', 'eventTicket', 'boardingPass'];
    const mains = (d: PackageDoc) =>
      Object.keys(d.passJson as object).filter((k) => MAIN.includes(k));
    each((o, t, seed) => {
      const m = mergePackages(base, o, t);
      for (const side of [undefined, 'ours', 'theirs'] as const) {
        const picks = side ? Object.fromEntries(m.conflicts.map((c) => [c.id, side])) : {};
        expect(mains(applyResolutions(base, o, t, picks)), `${side}, seed ${seed}`).toHaveLength(1);
      }
    });
  });
  it('conflict ids do not depend on which side is ours', () => {
    each((o, t, seed) => {
      expect(ids(base, o, t), `seed ${seed}`).toEqual(ids(base, t, o));
    });
  });
  it('a clean merge is stable: merging theirs again changes nothing', () => {
    each((o, t) => {
      const m = mergePackages(base, o, t);
      if (m.status !== 'clean') return;
      expect(bytes(mergePackages(base, m.merged, t).merged)).toBe(bytes(m.merged));
    });
  });
  it('applyResolutions with every conflict taken as ours equals merged', () => {
    each((o, t) => {
      const m = mergePackages(base, o, t);
      const picks = Object.fromEntries(m.conflicts.map((c) => [c.id, 'ours' as const]));
      expect(bytes(applyResolutions(base, o, t, picks))).toBe(bytes(m.merged));
      expect(applyResolutions(base, o, t, {})).toEqual(m.merged);
    });
  });
  it('picking a side for every conflict, round by round, reaches clean', () => {
    each((o, t, seed) => {
      for (const side of ['theirs', 'ours'] as const) {
        const picks: Record<string, Resolution> = {};
        let m = mergePackages(base, o, t);
        for (let round = 0; round < 4 && m.status !== 'clean'; round++) {
          for (const c of m.conflicts) picks[c.id] = side;
          m = mergePackages(base, o, t, { picks });
        }
        // A target `theirs` cannot bring back (its parent is gone) is kept by `ours`.
        for (const c of m.conflicts) picks[c.id] = 'ours';
        m = mergePackages(base, o, t, { picks });
        expect(
          m.conflicts.map((c) => c.id),
          `${side}, seed ${seed}`,
        ).toEqual([]);
      }
    });
  });
  it('is deterministic: the same bytes for equal input, whatever the base key order', () => {
    each((o, t, seed) => {
      const a = mergePackages(base, o, t);
      const again = mergePackages(structuredClone(base), structuredClone(o), structuredClone(t));
      expect(JSON.stringify(again)).toBe(JSON.stringify(a));
      const shuffled = mergePackages(reversed(base), o, t);
      expect(bytes(shuffled.merged), `seed ${seed}`).toBe(bytes(a.merged));
      expect(shuffled.conflicts.map((c) => c.id)).toEqual(a.conflicts.map((c) => c.id));
    });
  });
  it('outputs are sorted', () => {
    each((o, t) => {
      const m = mergePackages(base, o, t);
      const sorted = (xs: string[]) => [...xs].sort();
      expect(m.conflicts.map((c) => c.id)).toEqual(sorted(m.conflicts.map((c) => c.id)));
      const keys = m.theirs.map((c) => `${c.part}\0${c.path.join('/')}\0${c.op}`);
      expect(keys).toEqual(sorted(keys));
      expect(Object.keys(m.merged.files)).toEqual(sorted(Object.keys(m.merged.files)));
    });
  });
  it('two-way: merge(null, x, x) = x, and a clean two-way merge is ours', () => {
    each((x, y, seed) => {
      const r = mergePackages(null, x, x);
      expect(r.status).toBe('clean');
      expect(bytes(r.merged)).toBe(bytes(normalize(x)));
      const d = mergePackages(null, x, y);
      if (d.status === 'clean') expect(bytes(d.merged), `seed ${seed}`).toBe(bytes(normalize(x)));
    });
  });
});
