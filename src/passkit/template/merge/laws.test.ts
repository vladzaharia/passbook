import { describe, expect, it } from 'vitest';
import { applyResolutions, mergePackages } from './apply.ts';
import { baseDoc, edit, sha, stringsFile } from './merge-fixtures.ts';
import { normalize } from './normalize.ts';
import type { PackageDoc } from './types.ts';

function rng(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const GROUPS = ['primaryFields', 'secondaryFields', 'backFields'];

/** A random, benign edit: no renames, so the symmetry law applies. */
function mutate(doc: PackageDoc, r: () => number, n: number): PackageDoc {
  const pick = <T>(xs: T[]) => xs[Math.floor(r() * xs.length)] as T;
  const tok = () => `v${Math.floor(r() * 1e6)}`;
  return edit(doc, (d) => {
    const pass = d.passJson;
    const man = d.manifest;
    const fields = () => GROUPS.flatMap((g) => pass.generic[g] ?? []);
    const ops: (() => void)[] = [
      () => (pass.description = tok()),
      () => (pass.foregroundColor = pick(['red', 'blue', tok()])),
      () => (pass[`extra${Math.floor(r() * 3)}`] = tok()),
      () => (pass.semantics[`s${Math.floor(r() * 3)}`] = tok()),
      () => ((pick(fields()) as any).label = tok()),
      () => {
        const g = pick(GROUPS);
        pass.generic[g] = pass.generic[g] ?? [];
        pass.generic[g].splice(Math.floor(r() * 3), 0, { key: tok(), label: tok(), value: '' });
      },
      () => {
        const f = pick(fields()) as any;
        for (const g of GROUPS)
          pass.generic[g] = (pass.generic[g] ?? []).filter((x: any) => x !== f);
        man.bindings = man.bindings.filter((b: any) => b.to.field !== f.key);
      },
      () => pass.generic.secondaryFields.reverse(),
      () => (pass.barcodes[0].message = tok()),
      () => pass.locations.push({ latitude: r(), longitude: r() }),
      () => (man.description = tok()),
      () => (man.display.title = tok()),
      () => {
        const key = pick(['tier', 'pts', 'name']);
        if (!man.display.search.includes(key)) man.display.search.push(key);
      },
      () => man.bindings.splice(Math.floor(r() * 3), 0, { to: { field: 'name' }, value: tok() }),
      () =>
        (man.inputs.properties[tok()] = { type: 'string', maxLength: Math.floor(r() * 50) + 1 }),
      () => (man.inputs.properties.name.maxLength = Math.floor(r() * 90)),
      () => (man.sample[`k${Math.floor(r() * 3)}`] = tok()),
      () => (man.scan.actions[0].label = tok()),
      () =>
        man.scan.actions.push({ id: tok(), label: tok(), kind: 'add', input: 'pts', amount: 1 }),
      () => (man.scan.display.panels[0].rows[0].text = tok()),
      () => (man.scan.display.header.chips[0].text = tok()),
      () => (man.scan.display.customer.greet = r() < 0.5),
      () => (man.stamps.goal = Math.floor(r() * 10) + 3),
      () => (man.nfc[`n${Math.floor(r() * 2)}`] = tok()),
      () => (d.files[pick(['icon@2x.png', 'logo@2x.png', 'icon@3x.png'])] = { sha1: sha(tok()) }),
      () =>
        (d.files['en.lproj/pass.strings'] = stringsFile({
          Name: tok(),
          Tier: 'Tier',
          [tok()]: tok(),
        })),
    ];
    for (let i = 0; i < n; i++) pick(ops)();
  });
}

const SEEDS = Array.from({ length: 120 }, (_, i) => i + 1);
const ids = (b: PackageDoc, o: PackageDoc, t: PackageDoc) =>
  mergePackages(b, o, t).conflicts.map((c) => c.id);

describe('merge laws', () => {
  const base = baseDoc();
  const each = (fn: (o: PackageDoc, t: PackageDoc, seed: number) => void) => {
    for (const seed of SEEDS) {
      const r = rng(seed);
      fn(mutate(base, r, 1 + Math.floor(r() * 4)), mutate(base, r, 1 + Math.floor(r() * 4)), seed);
    }
  };

  it('merge(b, x, x) = x', () => {
    each((x) => {
      const r = mergePackages(base, x, x);
      expect(r.status).toBe('clean');
      expect(r.merged).toEqual(normalize(x));
    });
  });
  it('merge(b, b, t) = t and merge(b, o, b) = o', () => {
    each((o, t) => {
      expect(mergePackages(base, base, t).merged).toEqual(normalize(t));
      expect(mergePackages(base, o, base).merged).toEqual(normalize(o));
      expect(mergePackages(base, o, base).theirs).toEqual([]);
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
      expect(mergePackages(base, m.merged, t).merged).toEqual(m.merged);
    });
  });
  it('applyResolutions with every conflict taken as ours equals merged', () => {
    each((o, t) => {
      const m = mergePackages(base, o, t);
      const picks = Object.fromEntries(m.conflicts.map((c) => [c.id, 'ours' as const]));
      expect(applyResolutions(base, o, t, picks)).toEqual(m.merged);
      expect(applyResolutions(base, o, t, {})).toEqual(m.merged);
    });
  });
  it('taking theirs for every conflict leaves only reference conflicts or none', () => {
    each((o, t) => {
      const m = mergePackages(base, o, t);
      const picks = Object.fromEntries(m.conflicts.map((c) => [c.id, 'theirs' as const]));
      const left = mergePackages(base, o, t, { picks }).conflicts;
      expect(left.every((c) => c.kind === 'reference' || c.kind === 'invalid')).toBe(true);
    });
  });
  it('is deterministic: same bytes out for equal input, in any key order', () => {
    each((o, t) => {
      const a = JSON.stringify(mergePackages(base, o, t));
      expect(
        JSON.stringify(
          mergePackages(structuredClone(base), structuredClone(o), structuredClone(t)),
        ),
      ).toBe(a);
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
  it('two-way: merge(null, x, x) = x', () => {
    each((x) => {
      const r = mergePackages(null, x, x);
      expect(r.status).toBe('clean');
      expect(r.merged).toEqual(normalize(x));
    });
  });
});
