import { describe, expect, it } from 'vitest';
import type { TemplateManifest } from '../../types.ts';
import { applyResolutions, mergePackages } from './apply.ts';
import { RULED_KEYS } from './manifest.ts';
import { baseDoc, edit } from './merge-test-fixtures.ts';
import { UPGRADERS, type Upgraders, upgrade } from './versions.ts';

const m = (d: any) => d.manifest;

/** A fake schema 2: `display.title` is called `display.heading`. */
const rename = (manifest: Record<string, any>) => {
  const { title, ...rest } = manifest.display;
  return { ...manifest, display: { heading: title, ...rest } };
};
const step = (fn: (m: Record<string, any>) => Record<string, any>) => (d: any) => ({
  ...d,
  manifest: fn(d.manifest),
});
const upgraders: Upgraders = { schema: { 1: step(rename) } };
const v2 = (d: any) => {
  Object.assign(d.manifest, rename(d.manifest), { schema: 2 });
};

describe('upgrade', () => {
  it('is the identity for the current schema and does not change its input', () => {
    const doc = baseDoc();
    expect(upgrade(doc, 1, 1)).toBe(doc);
    expect(UPGRADERS).toEqual({});
    const lifted = m(upgrade(doc, 1, 2, upgraders.schema));
    expect(lifted.schema).toBe(2);
    expect(lifted.display.heading).toBe('{{name}}');
    expect(lifted.display.title).toBeUndefined();
    expect(m(doc).display.title).toBe('{{name}}');
  });
  it('chains steps and reports a missing one', () => {
    const steps = { 1: step((x) => ({ ...x, a: 1 })), 2: step((x) => ({ ...x, b: 2 })) };
    expect(m(upgrade(baseDoc(), 1, 3, steps))).toMatchObject({ schema: 3, a: 1, b: 2 });
    expect(upgrade(baseDoc(), 1, 3, { 1: steps[1] })).toBeUndefined();
    expect(upgrade(baseDoc(), 1, 2, undefined)).toBeUndefined();
  });
  it('a step can move pass.json and files with the manifest', () => {
    const moveLogo = (d: any) => {
      const { 'logo.png': logo, ...files } = d.files;
      return {
        ...d,
        passJson: { ...d.passJson, logoText: 'v2' },
        files: { ...files, 'brand.png': logo },
      };
    };
    const doc = edit(baseDoc(), (d) => (d.files['logo.png'] = { sha1: 'x' }));
    const lifted = upgrade(doc, 1, 2, { 1: moveLogo }) as any;
    expect(lifted.passJson.logoText).toBe('v2');
    expect(Object.keys(lifted.files)).toContain('brand.png');
    expect(Object.keys(lifted.files)).not.toContain('logo.png');
    expect(Object.keys(doc.files)).toContain('logo.png');
  });
});

describe('merge across a schema gap', () => {
  const base = baseDoc();
  it('with an upgrader: base and ours are lifted, then merged by key', () => {
    const o = edit(base, (d) => (m(d).display.title = 'Mine'));
    const t = edit(base, (d) => {
      v2(d);
      m(d).display.subtitle = 'Theirs';
    });
    const r = mergePackages(base, o, t, { upgraders });
    expect(r.status).toBe('clean');
    expect(r.merged.manifest).toMatchObject({
      schema: 2,
      display: { heading: 'Mine', subtitle: 'Theirs' },
    });
    expect((r.merged.manifest as any).display.title).toBeUndefined();
    // A real edit conflict still conflicts after the lift.
    const c = mergePackages(
      base,
      o,
      edit(base, (d) => {
        v2(d);
        m(d).display.heading = 'T';
      }),
      { upgraders },
    );
    expect(c.conflicts.map((x) => x.id)).toEqual(['display:heading']);
  });
  it('also lifts the fork when it is the newer side', () => {
    const o = edit(base, v2);
    const t = edit(base, (d) => (m(d).display.title = 'T'));
    const r = mergePackages(base, o, t, { upgraders });
    expect(r.status).toBe('clean');
    expect((r.merged.manifest as any).display.heading).toBe('T');
    expect(applyResolutions(base, o, t, {}, upgraders)).toEqual(r.merged);
  });
  it('without an upgrader it reports schema_upgrade_missing and keeps ours, without throwing', () => {
    const t = edit(base, v2);
    const o = edit(base, (d) => (m(d).description = 'Mine'));
    const r = mergePackages(base, o, t);
    expect(r.status).toBe('conflicted');
    expect(r.conflicts).toMatchObject([
      { id: 'manifest.meta:schema', kind: 'schema_upgrade_missing', base: 1, ours: 1, theirs: 2 },
    ]);
    expect((r.merged.manifest as any).description).toBe('Mine');
    expect(mergePackages(null, o, t).conflicts[0]).toMatchObject({ ours: 1, theirs: 2 });
    expect(() =>
      mergePackages(
        base,
        o,
        edit(base, (d) => (m(d).schema = 9)),
      ),
    ).not.toThrow();
  });
  it('a step missing partway is also a typed conflict', () => {
    const t = edit(base, (d) => (m(d).schema = 3));
    expect(mergePackages(base, base, t, { upgraders }).conflicts[0]?.kind).toBe(
      'schema_upgrade_missing',
    );
  });
  it('version sites use their own upgraders; equal versions merge as before', () => {
    const wallets2 = (d: any) => (m(d).wallets.schema = 2);
    const o = edit(base, (d) => m(d).wallets.google.omit.push('b'));
    const t = edit(base, wallets2);
    const reg: Upgraders = {
      wallets: {
        1: step((x) => ({
          ...x,
          wallets: { ...x.wallets, google: { ...x.wallets.google, images: {} } },
        })),
      },
    };
    const r = mergePackages(base, o, t, { upgraders: reg });
    expect(r.status).toBe('clean');
    expect(m(r.merged).wallets).toMatchObject({ schema: 2, google: { omit: ['a', 'b'] } });
    const missing = mergePackages(base, o, t);
    expect(missing.conflicts.map((c) => [c.id, c.kind])).toEqual([
      ['wallets:schema', 'schema_upgrade_missing'],
    ]);
    expect(m(missing.merged).wallets.schema).toBe(1);
  });
  it('scan.display.v bumps with their upgrader', () => {
    const reg: Upgraders = { 'scan.display': { 1: (x) => x } };
    const t = edit(base, (d) => (m(d).scan.display.v = 2));
    const r = mergePackages(base, base, t, { upgraders: reg });
    expect(r.status).toBe('clean');
    expect(m(r.merged).scan.display.v).toBe(2);
  });
});

describe('manifest rule coverage', () => {
  /** Every key of `TemplateManifest`; a new key fails to compile here until it is listed. */
  const KEYS = {
    schema: 'atomic',
    name: 'ours',
    description: 'rule',
    inputs: 'rule',
    sample: 'rule',
    lookups: 'rule',
    bindings: 'rule',
    display: 'rule',
    behaviors: 'rule',
    requires: 'rule',
    org: 'dropped',
    blueprint: 'dropped',
    previewOnlyAssets: 'rule',
    messaging: 'rule',
    email: 'rule',
    scan: 'rule',
    nfc: 'rule',
    stamps: 'rule',
    wallets: 'rule',
  } satisfies Record<keyof TemplateManifest, string>;
  it('every manifest key has a rule or sits on the explicit atomic, ours or dropped lists', () => {
    for (const [key, how] of Object.entries(KEYS))
      if (how === 'rule') expect(RULED_KEYS, key).toContain(key);
    expect(RULED_KEYS.filter((k) => !(k in KEYS))).toEqual([]);
  });
});
