import { describe, expect, it } from 'vitest';
import { applyResolutions, mergePackages } from './apply.ts';
import { baseDoc, edit, ids, kinds, man, run, sha } from './merge-test-fixtures.ts';
import { normalize } from './normalize.ts';

// Regressions for the Opus review of WP-1 (review-forks1.md): H3, H4, M1, M2, M4, M5, L1, L5, L7, L8.
const pass = (d: any) => d.passJson;
const toStoreCard = (d: any) => {
  pass(d).storeCard = pass(d).generic;
  delete pass(d).generic;
};
const STYLES = ['generic', 'posterGeneric', 'storeCard', 'coupon', 'eventTicket', 'boardingPass'];
const stylesOf = (p: any) => Object.keys(p).filter((k) => STYLES.includes(k));

describe('H3: fields follow a style switch', () => {
  const relabel = (d: any) => (pass(d).generic.secondaryFields[0].label = 'Mine');
  it('theirs switches, ours edits a field: one style, with ours edit in it', () => {
    const r = run(relabel, toStoreCard);
    expect(r.status).toBe('clean');
    expect(stylesOf(r.merged.passJson)).toEqual(['storeCard']);
    expect((r.merged.passJson as any).storeCard.secondaryFields[0]).toMatchObject({
      key: 'tier',
      label: 'Mine',
    });
    expect(r.theirs).toContainEqual({ part: 'pass.style', path: [], op: 'change' });
  });
  it('ours switches, theirs edits a field: theirs edit lands in ours style', () => {
    const r = run(toStoreCard, (d) => (pass(d).generic.backFields[0].label = 'T'));
    expect(r.status).toBe('clean');
    expect(stylesOf(r.merged.passJson)).toEqual(['storeCard']);
    expect((r.merged.passJson as any).storeCard.backFields[0].label).toBe('T');
  });
  it('both switch to the same style: fields still merge by key', () => {
    const r = run(
      (d) => {
        relabel(d);
        toStoreCard(d);
      },
      (d) => {
        pass(d).generic.backFields[0].label = 'T';
        toStoreCard(d);
      },
    );
    expect(r.status).toBe('clean');
    const s = (r.merged.passJson as any).storeCard;
    expect([s.secondaryFields[0].label, s.backFields[0].label]).toEqual(['Mine', 'T']);
  });
  it('both switch differently: one pass.style conflict; any pick keeps one style and both edits', () => {
    const base = baseDoc();
    const o = edit(base, (d) => {
      relabel(d);
      toStoreCard(d);
    });
    const t = edit(base, (d) => {
      pass(d).generic.backFields[0].label = 'T';
      pass(d).coupon = pass(d).generic;
      delete pass(d).generic;
    });
    const r = mergePackages(base, o, t);
    expect(kinds(r)).toEqual({ 'pass.style:': 'both-changed' });
    for (const [pick, style] of [
      ['ours', 'storeCard'],
      ['theirs', 'coupon'],
      [{ value: 'eventTicket' }, 'eventTicket'],
    ] as const) {
      const p = applyResolutions(base, o, t, { 'pass.style:': pick }) as any;
      expect(stylesOf(p.passJson)).toEqual([style]);
      const s = p.passJson[style];
      expect([s.secondaryFields[0].label, s.backFields[0].label]).toEqual(['Mine', 'T']);
    }
  });
});

describe('H4: barcodes', () => {
  const two = (d: any) =>
    pass(d).barcodes.push({ format: 'PKBarcodeFormatPDF417', message: 'p', messageEncoding: 'x' });
  it('a divergent removal on both sides conflicts even at equal lengths', () => {
    const base = edit(baseDoc(), two);
    const o = edit(base, (d) => pass(d).barcodes.shift());
    const t = edit(base, (d) => pass(d).barcodes.pop());
    const r = mergePackages(base, o, t);
    expect(kinds(r)).toEqual({ 'barcodes:barcodes': 'both-changed' });
    expect(mergePackages(base, o, o).status).toBe('clean');
  });
});

describe('M1: a rename onto a name ours uses', () => {
  it('is not offered as a rename; it merges as a delete plus an add', () => {
    const base = baseDoc();
    const o = edit(base, (d) => (d.manifest.inputs.properties.level = { type: 'number' }));
    const t = edit(base, (d) => {
      const p = d.manifest.inputs.properties;
      d.manifest.inputs.properties = { name: p.name, level: p.tier, pts: p.pts };
    });
    const r = mergePackages(base, o, t);
    expect(r.renames).toEqual([{ kind: 'input', from: 'tier', to: 'level', applied: false }]);
    expect(ids(r)).toContain('inputs:properties/level');
    expect(kinds(r)['inputs:properties/level']).toBe('add-add');
    const picked = applyResolutions(base, o, t, { 'inputs:properties/level': 'theirs' }) as any;
    expect(picked.manifest.inputs.properties.level).toEqual(
      (t.manifest as any).inputs.properties.level,
    );
    expect(Object.keys(picked.manifest.inputs.properties)).toEqual(['name', 'pts', 'level']);
  });
});

describe('M2: file picks', () => {
  const base = baseDoc();
  const o = edit(base, (d) => (d.files['logo@2x.png'] = { sha1: sha('o') }));
  const t = edit(base, (d) => (d.files['logo@2x.png'] = { sha1: sha('t') }));
  it('an upload on an image unit writes the scale it names', () => {
    const file = { file: { name: 'logo@3x.png', sha1: sha('new') } };
    const m = applyResolutions(base, o, t, { 'files.image:logo': file });
    expect(Object.keys(m.files).filter((n) => n.startsWith('logo'))).toEqual(['logo@3x.png']);
    expect(m.files['logo@3x.png']?.sha1).toBe(sha('new'));
    const scales = { value: { '1': sha('a'), '2': sha('b') } };
    const v = applyResolutions(base, o, t, { 'files.image:logo': scales });
    expect(Object.keys(v.files).filter((n) => n.startsWith('logo'))).toEqual([
      'logo.png',
      'logo@2x.png',
    ]);
  });
  it('a pick that does not fit leaves the conflict', () => {
    for (const bad of [
      { file: { name: 'icon@2x.png', sha1: sha('x') } },
      { value: { '7': 'x' } },
      { value: 'x' },
    ])
      expect(ids(mergePackages(base, o, t, { picks: { 'files.image:logo': bad } }))).toEqual([
        'files.image:logo',
      ]);
    const desc = (v: string) => (d: any) => (d.manifest.description = v);
    const r = mergePackages(base, edit(base, desc('O')), edit(base, desc('T')), {
      picks: { 'manifest.meta:description': { file: { name: 'x', sha1: 'y' } } },
    });
    expect(ids(r)).toEqual(['manifest.meta:description']);
  });
});

describe('M4: two-way never unions', () => {
  it('a required or set difference conflicts, an equal set does not', () => {
    const r = run(
      (d) => (d.manifest.inputs.required = []),
      (d) => (d.manifest.display.search = ['name']),
      true,
    );
    expect(kinds(r)).toEqual({ 'inputs:required': 'both-changed' });
    expect(man(r).inputs.required).toEqual([]);
    expect(run(undefined, (d) => d.manifest.display.search.reverse(), true).status).toBe('clean');
  });
  it('an order difference conflicts', () => {
    const r = run(undefined, (d) => pass(d).generic.secondaryFields.reverse(), true);
    expect(ids(r)).toEqual(['fields:#order']);
  });
});

describe('M5: order per style', () => {
  it('a poster style files its ids under its key', () => {
    const poster = (d: any) => (pass(d).posterGeneric = structuredClone(pass(d).generic));
    const base = edit(baseDoc(), poster);
    const rev = (d: any) => {
      pass(d).generic.secondaryFields.reverse();
      pass(d).posterGeneric.secondaryFields.reverse();
    };
    const r = mergePackages(
      base,
      edit(base, rev),
      edit(base, (d) => {
        pass(d).generic.secondaryFields.push(pass(d).generic.secondaryFields.shift());
        pass(d).posterGeneric.secondaryFields.push(pass(d).posterGeneric.secondaryFields.shift());
      }),
    );
    expect(ids(r)).toEqual(['fields:#order', 'fields:posterGeneric/#order']);
  });
});

describe('L1: key order follows ours, theirs new keys after their predecessor', () => {
  it('pass.json, field dicts and grouped keys keep their order', () => {
    const base = baseDoc();
    const t = edit(base, (d) => {
      const { organizationName, ...rest } = pass(d);
      d.passJson = { organizationName, logoText: 'L', ...rest };
      pass(d).generic = { headerFields: [], ...pass(d).generic };
    });
    const r = mergePackages(base, base, t).merged.passJson as any;
    expect(Object.keys(r).slice(0, 4)).toEqual([
      'formatVersion',
      'organizationName',
      'logoText',
      'description',
    ]);
    expect(Object.keys(r.generic)).toEqual(Object.keys((t.passJson as any).generic));
    const o = edit(base, (d) => {
      const { tier } = d.manifest.inputs.properties;
      d.manifest.inputs.properties.tier = {
        enum: tier.enum,
        type: 'string',
        'x-enumLabels': tier['x-enumLabels'],
      };
    });
    expect(JSON.stringify(mergePackages(base, o, base).merged.manifest)).toBe(
      JSON.stringify(normalize(o).manifest),
    );
  });
});

describe('L5, L7, L8', () => {
  it('featured actions without an identifier match whatever their key order', () => {
    const base = edit(baseDoc(), (d) => pass(d).featuredActions.push({ a: 1, b: 2 }));
    const t = edit(base, (d) => (pass(d).featuredActions[1] = { b: 2, a: 1 }));
    expect(mergePackages(base, base, t).status).toBe('clean');
  });
  it('both sides adding a container merge it by key', () => {
    const base = edit(baseDoc(), (d) => delete d.manifest.nfc);
    const r = mergePackages(
      base,
      edit(base, (d) => (d.manifest.nfc = { message: 'x', a: 1 })),
      edit(base, (d) => (d.manifest.nfc = { message: 'x', b: 2 })),
    );
    expect(r.status).toBe('clean');
    expect(man(r).nfc).toEqual({ message: 'x', a: 1, b: 2 });
  });
  it("a variant's header files under scan.display.header", () => {
    const title = (v: string) => (d: any) => (d.manifest.scan.display.variants[0].header.title = v);
    expect(ids(run(title('O'), title('T')))).toEqual([
      'scan.display.header:display/variants/v1/header/title',
    ]);
  });
});
