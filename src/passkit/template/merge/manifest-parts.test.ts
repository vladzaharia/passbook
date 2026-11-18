import { describe, expect, it } from 'vitest';
import { ids, kinds, man, run } from './merge-test-fixtures.ts';

const m = (d: any) => d.manifest;

describe('manifest.meta, inputs, sample, lookups', () => {
  it('manifest.meta: description K3, requires.styles set, messaging atomic', () => {
    const r = run(
      (d) => {
        m(d).description = 'O';
        m(d).requires.styles.push('coupon');
      },
      (d) => {
        m(d).requires.styles.push('storeCard');
        m(d).messaging = { input: 'name' };
      },
    );
    expect(r.status).toBe('clean');
    expect(man(r)).toMatchObject({
      description: 'O',
      requires: { styles: ['generic', 'coupon', 'storeCard'] },
      messaging: { input: 'name' },
    });
    expect(
      kinds(
        run(
          (d) => (m(d).description = 'A'),
          (d) => (m(d).description = 'B'),
        ),
      ),
    ).toEqual({
      'manifest.meta:description': 'both-changed',
    });
  });
  it('name always comes from ours; org and blueprint are dropped', () => {
    const r = run(
      (d) => (m(d).name = 'Mine'),
      (d) => {
        m(d).name = 'Theirs';
        m(d).blueprint = true;
        m(d).org = { slug: 'x', name: 'X' };
      },
    );
    expect(r.status).toBe('clean');
    expect(man(r).name).toBe('Mine');
    expect(man(r)).not.toHaveProperty('blueprint');
    expect(man(r)).not.toHaveProperty('org');
  });
  it('unknown manifest keys merge atomically', () => {
    const r = run(
      (d) => (m(d).future = { a: 1 }),
      (d) => (m(d).future = { a: 2 }),
    );
    expect(kinds(r)).toEqual({ 'manifest.meta:future': 'add-add' });
  });
  it('inputs merge by name, order is the form order, required is a set', () => {
    const r = run(
      (d) => {
        m(d).inputs.properties.name.maxLength = 10;
        m(d).inputs.required.push('tier');
      },
      (d) => {
        m(d).inputs.properties.name['x-label'] = 'Full name';
        m(d).inputs.properties.extra = { type: 'string' };
        m(d).inputs.required.push('pts');
      },
    );
    expect(r.status).toBe('clean');
    const props = m(r.merged).inputs.properties;
    expect(Object.keys(props)).toEqual(['name', 'tier', 'pts', 'extra']);
    expect(props.name).toMatchObject({ maxLength: 10, 'x-label': 'Full name' });
    expect(m(r.merged).inputs.required).toEqual(['name', 'tier', 'pts']);
  });
  it('enum and x-enumLabels are one unit', () => {
    const r = run(
      (d) => (m(d).inputs.properties.tier.enum = ['a', 'b', 'c']),
      (d) => (m(d).inputs.properties.tier['x-enumLabels'] = { a: 'AA', b: 'B' }),
    );
    expect(ids(r)).toEqual(['inputs:properties/tier/enum+x-enumLabels']);
    const ok = run(
      undefined,
      (d) => (m(d).inputs.properties.tier['x-enumLabels'] = { a: 'AA', b: 'B' }),
    );
    expect(m(ok.merged).inputs.properties.tier['x-enumLabels']).toEqual({ a: 'AA', b: 'B' });
  });
  it('input reorder from theirs applies when ours did not reorder', () => {
    const r = run(undefined, (d) => {
      const { name, ...rest } = m(d).inputs.properties;
      m(d).inputs.properties = { ...rest, name };
    });
    expect(Object.keys(m(r.merged).inputs.properties)).toEqual(['tier', 'pts', 'name']);
  });
  it('sample and lookups merge per key at each level', () => {
    const r = run(
      (d) => {
        m(d).sample.tier = 'a';
        m(d).lookups.tiers.a.label = 'O';
      },
      (d) => {
        m(d).sample.pts = 3;
        m(d).lookups.tiers.b = { label: 'Beta' };
        m(d).lookups.other = { x: { y: 1 } };
      },
    );
    expect(r.status).toBe('clean');
    expect(man(r).sample).toEqual({ name: 'Ada', tier: 'a', pts: 3 });
    expect(man(r).lookups).toMatchObject({
      tiers: { a: { label: 'O' }, b: { label: 'Beta' } },
      other: { x: { y: 1 } },
    });
    expect(
      kinds(
        run(
          (d) => (m(d).sample.name = 'O'),
          (d) => (m(d).sample.name = 'T'),
        ),
      ),
    ).toEqual({ 'sample:name': 'both-changed' });
  });
});

describe('bindings, display, behaviors, previewOnlyAssets', () => {
  it('bindings merge by target and n-th, keeping order', () => {
    const extra = { to: { field: 'name' }, value: 'x', when: { input: 'tier', eq: 'a' } };
    const r = run(
      (d) => (m(d).bindings[1].value = 'O'),
      (d) => m(d).bindings.splice(1, 0, extra),
    );
    expect(r.status).toBe('clean');
    expect(man(r).bindings.map((b: any) => b.value)).toEqual(['{{name}}', 'x', 'O', '{{pts}}']);
  });
  it('a binding edited on both sides conflicts under its identity', () => {
    const r = run(
      (d) => (m(d).bindings[0].value = 'O'),
      (d) => (m(d).bindings[0].value = 'T'),
    );
    expect(ids(r)).toEqual(['bindings:{"field":"name"}#0/value']);
  });
  it('display: keys K3, search is a set, icon K3', () => {
    const r = run(
      (d) => (m(d).display.title = 'O'),
      (d) => {
        m(d).display.search.push('tier');
        m(d).display.icon = 'star';
      },
    );
    expect(man(r).display).toMatchObject({ title: 'O', search: ['name', 'tier'], icon: 'star' });
  });
  it('behaviors merge by use and config key; previewOnlyAssets is a set', () => {
    const r = run(
      (d) => (m(d).behaviors[0].config.extra = 1),
      (d) => {
        m(d).behaviors[0].version = 2;
        m(d).previewOnlyAssets.push('b.png');
      },
    );
    expect(man(r).behaviors[0]).toEqual({
      use: 'tiers',
      version: 2,
      config: { table: 'tiers', extra: 1 },
    });
    expect(man(r).previewOnlyAssets).toEqual(['preview.png', 'b.png']);
    const cfg = run(
      (d) => (m(d).behaviors[0].config.table = 'o'),
      (d) => (m(d).behaviors[0].config.table = 't'),
    );
    expect(ids(cfg)).toEqual(['behaviors:tiers#0/config/table']);
  });
});

describe('nfc, stamps, wallets', () => {
  it('nfc merges per key', () => {
    const r = run(
      (d) => (m(d).nfc.message = 'o'),
      (d) => (m(d).nfc.extra = 't'),
    );
    expect(man(r).nfc).toEqual({ message: 'o', extra: 't' });
  });
  it('stamps goal and keepReady move as one unit', () => {
    const r = run(
      (d) => (m(d).stamps.goal = 8),
      (d) => {
        m(d).stamps.goal = 12;
        m(d).stamps.keepReady = true;
      },
    );
    expect(ids(r)).toEqual(['stamps:goal+keepReady']);
    const ok = run(undefined, (d) => {
      m(d).stamps.goal = 12;
      m(d).stamps.keepReady = true;
    });
    expect(man(ok).stamps).toMatchObject({ goal: 12, keepReady: true });
    const art = run(
      (d) => (m(d).stamps.art.reward = 'stamps/r.png'),
      (d) => (m(d).stamps.tilt = false),
    );
    expect(man(art).stamps).toMatchObject({ tilt: false, art: { reward: 'stamps/r.png' } });
  });
  it('wallets: roles per role, required and omit are sets', () => {
    const r = run(
      (d) => m(d).wallets.google.omit.push('b'),
      (d) => {
        m(d).wallets.roles = { title: { field: 'name' } };
        m(d).wallets.google.omit.push('c');
        m(d).wallets.samsung = { omit: ['z'] };
      },
    );
    expect(r.status).toBe('clean');
    expect(man(r).wallets.google.omit).toEqual(['a', 'b', 'c']);
    expect(man(r).wallets.roles).toEqual({ title: { field: 'name' } });
    expect(man(r).wallets.samsung).toEqual({ omit: ['z'] });
  });
});
