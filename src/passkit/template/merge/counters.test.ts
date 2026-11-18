import { describe, expect, it } from 'vitest';
import { mergePackages } from './index.ts';
import { type Any, baseDoc, edit, kinds, man } from './merge-test-fixtures.ts';
import { walkRefs } from './ref-walk.ts';

const counter = { input: 'pts', size: 5 };
const art = { filled: 'stamps/a.png', empty: 'stamps/b.png' };

/** A base that already has a counter, then ours and theirs edits of it. */
function run(o?: (c: Any) => void, t?: (c: Any) => void) {
  const base = edit(baseDoc(), (d) => {
    d.manifest.counters = { visits: structuredClone(counter), pack: { input: 'tier', size: 3 } };
  });
  const side = (fn?: (c: Any) => void) => edit(base, (d) => fn?.(d.manifest.counters));
  return mergePackages(base, side(o), side(t));
}

describe('counters merge', () => {
  it('takes a counter block added upstream into a fork that has none', () => {
    const base = baseDoc();
    const theirs = edit(base, (d) => (d.manifest.counters = { visits: counter }));
    const r = mergePackages(base, edit(base), theirs);
    expect(r.status).toBe('clean');
    expect(man(r).counters).toEqual({ visits: counter });
  });
  it('merges edits to different counters', () => {
    const r = run(
      (c) => (c.visits.size = 8),
      (c) => (c.pack.size = 4),
    );
    expect(r.status).toBe('clean');
    expect(man(r).counters).toMatchObject({ visits: { size: 8 }, pack: { size: 4 } });
  });
  it('merges art and size of one counter', () => {
    const r = run(
      (c) => (c.visits.tilt = false),
      (c) => (c.visits.art = art),
    );
    expect(r.status).toBe('clean');
    expect(man(r).counters.visits).toMatchObject({ tilt: false, art });
  });
  it('conflicts when one counter changes two ways', () => {
    const r = run(
      (c) => (c.visits.size = 6),
      (c) => (c.visits.size = 7),
    );
    expect(Object.values(kinds(r))).toEqual(['both-changed']);
  });
  it('removes a counter upstream dropped', () => {
    const r = run(undefined, (c) => delete c.pack);
    expect(r.status).toBe('clean');
    expect(Object.keys(man(r).counters)).toEqual(['visits']);
  });
});

describe('counters references', () => {
  it('visits the input and the art by identity, and rewrites them', () => {
    const doc = edit(baseDoc(), (d) => {
      d.manifest.counters = { visits: { ...counter, art: { ...art } } };
    });
    const seen: string[] = [];
    walkRefs(doc, (kind, id, site) => {
      if (site.startsWith('counters/')) seen.push(`${kind}:${id}@${site}`);
      return kind === 'input' && id === 'pts' ? 'points' : undefined;
    });
    expect(seen).toEqual([
      'input:pts@counters/visits/input',
      'art:stamps/a.png@counters/visits/art/filled',
      'art:stamps/b.png@counters/visits/art/empty',
    ]);
    expect((doc.manifest as Any).counters.visits.input).toBe('points');
  });
});
