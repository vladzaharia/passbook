import { describe, expect, it } from 'vitest';
import { applyResolutions, mergePackages } from './apply.ts';
import { baseDoc, edit, ids, kinds, man, run, stringsFile } from './merge-test-fixtures.ts';
import { readStrings } from './strings.ts';
import type { PackageDoc } from './types.ts';

// Regressions for the second Opus review of WP-1 (review-forks1-r2.md).
const m = (d: any) => d.manifest;
const refs = (r: { conflicts: { kind: string; id: string }[] }) =>
  r.conflicts.filter((c) => c.kind === 'reference').map((c) => c.id);
const json = (e?: { bytes?: Uint8Array }) => JSON.parse(new TextDecoder().decode(e?.bytes));

describe('R2-M1: picks on per-key file conflicts', () => {
  const base = baseDoc();
  const put = (values: Record<string, string>) => (d: any) =>
    (d.files['en.lproj/pass.strings'] = stringsFile(values));
  const [o, t] = [
    edit(base, put({ Name: 'A', Tier: 'Tier' })),
    edit(base, put({ Name: 'B', Tier: 'Tier' })),
  ];
  const id = 'strings:en.lproj/pass.strings/Name';
  it('a .strings key takes a string value and refuses a file pick', () => {
    expect(ids(mergePackages(base, o, t))).toEqual([id]);
    const v = mergePackages(base, o, t, { picks: { [id]: { value: 'Mitglied' } } });
    expect(v.status).toBe('clean');
    expect(readStrings(v.merged.files['en.lproj/pass.strings']?.bytes as Uint8Array).Name).toBe(
      'Mitglied',
    );
    for (const bad of [{ file: { name: 'x', sha1: 'y' } }, { value: { a: 1 } }])
      expect(ids(mergePackages(base, o, t, { picks: { [id]: bad } }))).toEqual([id]);
  });
  it('a personalization.json key takes any JSON value', () => {
    const write = (patch: object) => (d: any) => {
      const next = new TextEncoder().encode(
        JSON.stringify({ ...json(d.files['personalization.json']), ...patch }),
      );
      d.files['personalization.json'] = { sha1: JSON.stringify(patch), bytes: next };
    };
    const [po, pt] = [
      edit(base, write({ description: 'A' })),
      edit(base, write({ description: 'B' })),
    ];
    const pid = 'files.other:personalization.json/description';
    const r = mergePackages(base, po, pt, { picks: { [pid]: { value: 'C' } } });
    expect(r.status).toBe('clean');
    expect(json(r.merged.files['personalization.json']).description).toBe('C');
    expect(
      ids(mergePackages(base, po, pt, { picks: { [pid]: { file: { name: 'x', sha1: 'y' } } } })),
    ).toEqual([pid]);
  });
  it('a whole .strings file still takes a file pick', () => {
    const [ao, at] = [
      edit(base, (d) => (d.files['en.lproj/pass.strings'] = { sha1: 'a' })),
      edit(base, (d) => (d.files['en.lproj/pass.strings'] = { sha1: 'b' })),
    ];
    const whole = 'strings:en.lproj/pass.strings';
    const r = mergePackages(base, ao, at, {
      picks: { [whole]: { file: { name: 'x', sha1: 'c' } } },
    });
    expect([r.status, r.merged.files['en.lproj/pass.strings']?.sha1]).toEqual(['clean', 'c']);
  });
});

describe('R2-M2: a barcode swap or replacement under a fork binding', () => {
  const base = edit(baseDoc(), (d) =>
    d.passJson.barcodes.push({
      format: 'PKBarcodeFormatPDF417',
      message: 'p',
      messageEncoding: 'x',
    }),
  );
  const o = edit(base, (d) =>
    m(d).bindings.push({ to: { barcode: 1, prop: 'message' }, value: '{{name}}' }),
  );
  const site = 'references:barcode/1/bindings/{"barcode":1,"prop":"message"}#0';
  it('flags a swap and a format change at the bound index', () => {
    const swap = edit(base, (d) => d.passJson.barcodes.reverse());
    expect(refs(mergePackages(base, o, swap))).toEqual([site]);
    const aztec = edit(base, (d) => (d.passJson.barcodes[1].format = 'PKBarcodeFormatAztec'));
    expect(refs(mergePackages(base, o, aztec))).toEqual([site]);
  });
  it('an edit at an index whose barcode upstream moved never mixes two barcodes', () => {
    const swap = edit(base, (d) => d.passJson.barcodes.reverse());
    const edited = edit(base, (d) => (d.passJson.barcodes[0].message = 'mine'));
    const r = mergePackages(base, edited, swap);
    expect(ids(r)).toEqual(['barcodes:barcodes/0']);
    const t = applyResolutions(base, edited, swap, { 'barcodes:barcodes/0': 'theirs' });
    expect((t.passJson as any).barcodes).toEqual((swap.passJson as any).barcodes);
  });
  it('a message change at the index, or upstream moving its own binding, is clean', () => {
    const msg = edit(base, (d) => (d.passJson.barcodes[1].message = 'q'));
    expect(mergePackages(base, o, msg).status).toBe('clean');
    const own = edit(o, (d) => d.passJson.barcodes.reverse());
    expect(mergePackages(base, base, own).status).toBe('clean');
  });
});

describe('R2-L1: a reference upstream also left dangling does not hide a fork reference', () => {
  it('a fork flag on an input upstream deleted is flagged', () => {
    const r = run(
      (d) => m(d).scan.flags.push({ input: 'pts', label: 'Many', equals: [9] }),
      (d) => {
        delete m(d).inputs.properties.pts;
        m(d).scan.flags.unshift({ input: 'pts', label: 'Old', equals: [1] });
      },
    );
    expect(refs(r)).toContain('references:input/pts/scan/flags/pts#0');
  });
});

describe('R2-L2: a rename onto a name ours uses is always shown', () => {
  it('even when both schemas are equal', () => {
    const base = baseDoc();
    const o = edit(
      base,
      (d) => (m(d).inputs.properties.level = structuredClone(m(d).inputs.properties.tier)),
    );
    const t = edit(base, (d) => {
      const p = m(d).inputs.properties;
      m(d).inputs.properties = { name: p.name, level: p.tier, pts: p.pts };
    });
    const r = mergePackages(base, o, t);
    expect(kinds(r)).toMatchObject({ 'inputs:tier': 'rename-modify' });
    expect(ids(mergePackages(base, o, t, { picks: { 'inputs:tier': 'theirs' } }))).toContain(
      'inputs:tier',
    );
    expect(ids(mergePackages(base, o, t, { picks: { 'inputs:tier': 'ours' } }))).not.toContain(
      'inputs:tier',
    );
  });
});

describe('R2-L3: a pass.style value pick must be a main style', () => {
  it('a poster or unknown style leaves the conflict', () => {
    const to = (s: string) => (d: any) => {
      d.passJson[s] = d.passJson.generic;
      delete d.passJson.generic;
    };
    const base = baseDoc();
    const [o, t] = [edit(base, to('storeCard')), edit(base, to('coupon'))];
    for (const bad of ['posterGeneric', 'foo', 3])
      expect(ids(mergePackages(base, o, t, { picks: { 'pass.style:': { value: bad } } }))).toEqual([
        'pass.style:',
      ]);
    const ok = applyResolutions(base, o, t, { 'pass.style:': { value: 'eventTicket' } });
    expect(Object.keys(ok.passJson as object)).toContain('eventTicket');
  });
});

describe('R2-L4: an input rename touches identifiers only', () => {
  it('leaves filters and literal text alone', () => {
    const r = run(
      (d) => {
        m(d).inputs.properties.upper = { type: 'string' };
        m(d).display.status = 'upper: {{name|upper}} {{ upper }} {{lookups.tiers[upper].label}}';
      },
      (d) => {
        const p = m(d).inputs.properties;
        m(d).inputs.properties = { ...p };
        m(d).display.title = '{{name|html}}';
      },
    );
    expect(man(r).display.status).toBe(
      'upper: {{name|upper}} {{ upper }} {{lookups.tiers[upper].label}}',
    );
    const base = edit(baseDoc(), (d) => {
      m(d).inputs.properties.upper = { type: 'string', maxLength: 3 };
      m(d).display.status = 'upper: {{name|upper}} {{ upper }} {{lookups.tiers[upper].label}}';
    });
    const t = edit(base, (d) => {
      const { upper, ...p } = m(d).inputs.properties;
      m(d).inputs.properties = { ...p, caps: upper };
    });
    const renamed = mergePackages(base, base, t) as { merged: PackageDoc };
    expect((renamed.merged.manifest as any).display.status).toBe(
      'upper: {{name|upper}} {{ caps }} {{lookups.tiers[caps].label}}',
    );
  });
});
