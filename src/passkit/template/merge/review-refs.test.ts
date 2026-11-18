import { describe, expect, it } from 'vitest';
import { applyResolutions, mergePackages } from './apply.ts';
import { baseDoc, edit, ids, kinds, man, run } from './merge-test-fixtures.ts';
import type { PackageDoc } from './types.ts';

// Regressions for the Opus review of WP-1 (review-forks1.md): H1, H2, M3, L6.
const m = (d: any) => d.manifest;
const disp = (d: any) => m(d).scan.display;
const refs = (r: { conflicts: { kind: string; id: string }[] }) =>
  r.conflicts.filter((c) => c.kind === 'reference').map((c) => c.id);

const barcode = (format: string) => ({ format, message: format, messageEncoding: 'iso-8859-1' });
const bindBarcode = (i: number) => (d: any) =>
  m(d).bindings.push({ to: { barcode: i, prop: 'message' }, value: '{{name}}' });

describe('H1: featured actions, barcodes, image slots and wallet art', () => {
  const base3 = edit(baseDoc(), (d) =>
    d.passJson.barcodes.push(barcode('PDF417'), barcode('Aztec')),
  );
  it('a barcode index past the merged list, or one that shifted, is a reference conflict', () => {
    const o = edit(base3, bindBarcode(2));
    const dropLast = edit(base3, (d) => d.passJson.barcodes.pop());
    expect(refs(mergePackages(base3, o, dropLast))).toEqual([
      'references:barcode/2/bindings/{"barcode":2,"prop":"message"}#0',
    ]);
    const o1 = edit(base3, bindBarcode(1));
    const dropFirst = edit(base3, (d) => d.passJson.barcodes.shift());
    expect(refs(mergePackages(base3, o1, dropFirst))).toEqual([
      'references:barcode/1/bindings/{"barcode":1,"prop":"message"}#0',
    ]);
    // Theirs moved its own binding with its barcodes: nothing broke.
    const both = edit(dropFirst, bindBarcode(0));
    expect(mergePackages(base3, base3, both).status).toBe('clean');
    expect(
      mergePackages(
        base3,
        o1,
        edit(base3, (d) => (d.passJson.barcodes[0].altText = 'x')),
      ).status,
    ).toBe('clean');
  });
  it('a featured action theirs removed under ours binding is a reference conflict', () => {
    const r = run(
      (d) => m(d).bindings.push({ to: { action: 'call', prop: 'url' }, value: 'tel:1' }),
      (d) => (d.passJson.featuredActions = []),
    );
    expect(refs(r)).toEqual([
      'references:featuredAction/call/bindings/{"action":"call","prop":"url"}#0',
    ]);
  });
  it('an image slot and wallet art removed under ours reference are conflicts', () => {
    const r = run(
      (d) => {
        m(d).bindings.push({ to: { image: 'logo' }, remove: { input: 'tier', eq: 'a' } });
        m(d).wallets.google.images = { hero: 'wallets/google/hero.png' };
      },
      (d) => {
        for (const n of ['logo@2x.png', 'de.lproj/logo@2x.png', 'wallets/google/hero.png'])
          delete d.files[n];
      },
    );
    expect(refs(r)).toEqual([
      'references:imageSlot/logo/bindings/{"image":"logo"}#0',
      'references:walletArt/wallets/google/hero.png/wallets/google/images/hero',
    ]);
  });
});

/** Upstream renames input `tier` to `level`, with every reference upstream knows about. */
const renameTier = (d: any) => {
  const p = m(d).inputs.properties;
  m(d).inputs.properties = { name: p.name, level: p.tier, pts: p.pts };
  for (const b of m(d).bindings) b.value = b.value.replace('{{tier}}', '{{level}}');
  m(d).display.subtitle = '{{level}}';
  m(d).scan.flags[0].input = 'level';
  m(d).scan.access.input.plan = 'level';
  disp(d).variants[0].when.input = 'level';
};

describe('H2: a clean rename reaches every reference site', () => {
  it('scan.display texts, conditions and rows; behaviors config; wallets expressions', () => {
    const r = run((d) => {
      disp(d).variants.push({
        id: 'v2',
        name: 'B',
        when: { path: 'inputs.tier', eq: 'b' },
        header: { title: 'B' },
      });
      disp(d).panels[0].rows.push(
        {
          id: 'r3',
          type: 'note',
          text: '{{inputs.tier}} and {{ tier | upper }} at {{lookups.tiers[tier].label}}',
          when: { input: 'tier', eq: 'a' },
        },
        { id: 'r4', type: 'history', source: 'value', input: 'tier' },
      );
      m(d).behaviors.push({ use: 'expiry-from-input', version: 1, config: { input: 'tier' } });
      m(d).wallets.roles = { tier: { value: 'Tier {{tier}}' } };
      m(d).wallets.google.classKey = '{{tier}}';
    }, renameTier);
    expect(r.status).toBe('clean');
    const x = man(r);
    const d = x.scan.display;
    expect(d.variants[1].when).toEqual({ path: 'inputs.level', eq: 'b' });
    expect(d.panels[0].rows[2]).toMatchObject({
      text: '{{inputs.level}} and {{ level | upper }} at {{lookups.tiers[level].label}}',
      when: { input: 'level', eq: 'a' },
    });
    expect(d.panels[0].rows[3].input).toBe('level');
    expect(x.behaviors[1].config).toEqual({ input: 'level' });
    expect(x.wallets.roles.tier.value).toBe('Tier {{level}}');
    expect(x.wallets.google.classKey).toBe('{{level}}');
  });
  it('fields and actions in scan.display follow their renames', () => {
    const r = run(
      (d) => {
        disp(d).panels[0].rows.push(
          {
            id: 'r3',
            type: 'note',
            text: 'Since {{fields.since}}',
            when: { path: 'fields.since', empty: false },
          },
          { id: 'r4', type: 'money', amount: '{{pts}}', pending: ['add'] },
        );
      },
      (d) => {
        d.passJson.generic.secondaryFields[2].key = 'joined';
        m(d).scan.actions[0].id = 'plus';
        disp(d).panels[0].actions = ['plus'];
      },
    );
    expect(r.status).toBe('clean');
    const rows = man(r).scan.display.panels[0].rows;
    expect(rows[2]).toMatchObject({
      text: 'Since {{fields.joined}}',
      when: { path: 'fields.joined' },
    });
    expect(rows[3].pending).toEqual(['plus']);
  });
  it('a delete upstream breaks the fork reference: a reference conflict, not a clean merge', () => {
    const r = run(
      (d) =>
        disp(d).variants.push({
          id: 'v2',
          name: 'B',
          when: { path: 'inputs.pts', gt: 5 },
          header: { title: 'B' },
        }),
      (d) => {
        delete m(d).inputs.properties.pts;
        m(d).bindings = m(d).bindings.filter((b: any) => b.to.field !== 'pts');
        m(d).scan.actions = [];
        disp(d).panels[0].actions = [];
        m(d).stamps.input = 'name';
      },
    );
    expect(refs(r)).toEqual(['references:input/pts/scan/display/variants/v2']);
  });
});

describe('M3: reference and schema gap conflicts take picks', () => {
  const base = baseDoc();
  const o = edit(base, (d) => d.passJson.generic.secondaryFields.pop());
  const t = edit(base, (d) => m(d).bindings.push({ to: { field: 'since' }, value: 'x' }));
  const id = 'references:field/since/bindings/{"field":"since"}#0';
  it('ours keeps the merge; theirs brings the target back', () => {
    expect(ids(mergePackages(base, o, t))).toEqual([id]);
    const kept = mergePackages(base, o, t, { picks: { [id]: 'ours' } });
    expect(kept.status).toBe('clean');
    expect(kept.merged).toEqual(mergePackages(base, o, t).merged);
    const back = mergePackages(base, o, t, { picks: { [id]: 'theirs' } });
    expect(back.status).toBe('clean');
    expect((back.merged.passJson as any).generic.secondaryFields.map((f: any) => f.key)).toEqual([
      'tier',
      'pts',
      'since',
    ]);
  });
  it('ids do not move when an earlier binding goes', () => {
    const o2 = edit(o, (d) => m(d).bindings.shift());
    expect(ids(mergePackages(base, o2, t))).toContain(id);
  });
  it('theirs brings back stamp art and an image slot', () => {
    const o3 = edit(base, (d) => {
      delete d.files['logo@2x.png'];
      delete d.files['de.lproj/logo@2x.png'];
    });
    const t3 = edit(base, (d) => m(d).bindings.push({ to: { image: 'logo' }, value: 'x' }));
    const r = mergePackages(base, o3, t3);
    const ref = refs(r)[0] as string;
    const back = applyResolutions(base, o3, t3, { [ref]: 'theirs' });
    expect(Object.keys(back.files)).toEqual(
      expect.arrayContaining(['logo@2x.png', 'de.lproj/logo@2x.png']),
    );
  });
  it('a schema gap takes a whole side', () => {
    const v2 = edit(base, (d) => {
      m(d).schema = 2;
      m(d).description = 'T';
      m(d).name = 'Upstream';
    });
    const mine = edit(base, (d) => (m(d).description = 'Mine'));
    const gap = 'manifest.meta:schema';
    const theirs = mergePackages(base, mine, v2, { picks: { [gap]: 'theirs' } });
    expect(theirs.status).toBe('clean');
    expect(man(theirs)).toMatchObject({ schema: 2, description: 'T', name: 'Base' });
    const ours = mergePackages(base, mine, v2, { picks: { [gap]: 'ours' } });
    expect([ours.status, man(ours).description]).toEqual(['clean', 'Mine']);
  });
  it('a part gap takes that part from the picked side', () => {
    const t2 = edit(base, (d) => Object.assign(m(d).wallets, { schema: 2, required: ['x'] }));
    const o2 = edit(base, (d) => (m(d).wallets.google.omit = ['z']));
    const r = mergePackages(base, o2, t2, { picks: { 'wallets:schema': 'theirs' } });
    expect(r.status).toBe('clean');
    expect(man(r).wallets).toEqual((t2.manifest as any).wallets);
  });
});

describe('L6: a rename of what ours deleted', () => {
  it('flags theirs new reference to the new name', () => {
    const o = (d: any) => {
      delete m(d).inputs.properties.pts;
      m(d).bindings = m(d).bindings.filter((b: any) => b.value !== '{{pts}}');
    };
    const t = (d: any) => {
      const p = m(d).inputs.properties;
      m(d).inputs.properties = { name: p.name, tier: p.tier, points: p.pts };
      m(d).bindings.push({ to: { field: 'pts', prop: 'label' }, value: '{{points}} pts' });
    };
    const r: { conflicts: any[]; renames: any[]; merged: PackageDoc } = run(o, t);
    expect(r.renames).toEqual([{ kind: 'input', from: 'pts', to: 'points', applied: false }]);
    expect(kinds(r)).toMatchObject({
      'references:input/pts/bindings/{"field":"pts","prop":"label"}#0': 'reference',
    });
  });
});
