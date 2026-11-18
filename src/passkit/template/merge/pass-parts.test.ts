import { describe, expect, it } from 'vitest';
import { applyResolutions } from './apply.ts';
import { baseDoc, ids, kinds, man, run, style } from './merge-fixtures.ts';

const pass = (d: any) => d.passJson;

describe('pass.meta', () => {
  it('merges disjoint keys', () => {
    const r = run(
      (d) => (pass(d).foregroundColor = 'red'),
      (d) => (pass(d).description = 'New'),
    );
    expect(r.status).toBe('clean');
    expect(r.merged.passJson).toMatchObject({ foregroundColor: 'red', description: 'New' });
    expect(r.theirs).toEqual([{ part: 'pass.meta', path: ['description'], op: 'change' }]);
  });
  it('conflicts when both change a key differently, equal changes are clean', () => {
    const r = run(
      (d) => (pass(d).description = 'A'),
      (d) => (pass(d).description = 'B'),
    );
    expect(kinds(r)).toEqual({ 'pass.meta:description': 'both-changed' });
    expect((r.merged.passJson as any).description).toBe('A');
    expect(
      run(
        (d) => (pass(d).description = 'A'),
        (d) => (pass(d).description = 'A'),
      ).status,
    ).toBe('clean');
  });
  it('merges semantics by key and keeps unknown keys atomic', () => {
    const r = run(
      (d) => (pass(d).semantics.total = 2),
      (d) => {
        pass(d).semantics.balance = 5;
        pass(d).extra = { a: 1 };
      },
    );
    expect(r.status).toBe('clean');
    expect(pass(r.merged)).toMatchObject({ semantics: { balance: 5, total: 2 }, extra: { a: 1 } });
  });
  it('flags add-add, delete-modify and modify-delete', () => {
    expect(
      kinds(
        run(
          (d) => (pass(d).x = 1),
          (d) => (pass(d).x = 2),
        ),
      ),
    ).toEqual({ 'pass.meta:x': 'add-add' });
    const dm = run(
      (d) => delete pass(d).description,
      (d) => (pass(d).description = 'T'),
    );
    expect(kinds(dm)).toEqual({ 'pass.meta:description': 'delete-modify' });
    expect((dm.merged.passJson as any).description).toBeUndefined();
    const md = run(
      (d) => (pass(d).description = 'O'),
      (d) => delete pass(d).description,
    );
    expect(kinds(md)).toEqual({ 'pass.meta:description': 'modify-delete' });
    expect(
      run(
        (d) => delete pass(d).description,
        (d) => delete pass(d).description,
      ).status,
    ).toBe('clean');
  });
});

describe('pass.style', () => {
  it('takes theirs when only theirs switched style, conflicts when both did', () => {
    const swap = (to: string) => (d: any) => {
      pass(d)[to] = pass(d).generic;
      delete pass(d).generic;
    };
    const r = run(undefined, swap('coupon'));
    expect(r.status).toBe('clean');
    expect(Object.keys(pass(r.merged))).toContain('coupon');
    expect(ids(run(swap('storeCard'), swap('coupon')))).toEqual(['pass.style:']);
    expect(run(swap('coupon'), undefined).merged.passJson).toHaveProperty('coupon');
  });
  it('merges keys inside the style dict', () => {
    const r = run(
      (d) => (pass(d).generic.transitType = 'a'),
      (d) => (pass(d).generic.row = 1),
    );
    expect(style(r)).toMatchObject({ transitType: 'a', row: 1 });
  });
});

describe('fields', () => {
  it('merges properties per field and takes theirs additions after their neighbour', () => {
    const r = run(
      (d) => (pass(d).generic.secondaryFields[0].value = 'o'),
      (d) => {
        pass(d).generic.secondaryFields[0].label = 'T';
        pass(d).generic.secondaryFields.splice(1, 0, { key: 'new', label: 'N', value: '' });
      },
    );
    expect(r.status).toBe('clean');
    expect(style(r).secondaryFields.map((f: any) => f.key)).toEqual([
      'tier',
      'new',
      'pts',
      'since',
    ]);
    expect(style(r).secondaryFields[0]).toMatchObject({ label: 'T', value: 'o' });
  });
  it('conflicts per property', () => {
    const r = run(
      (d) => (pass(d).generic.secondaryFields[0].label = 'O'),
      (d) => (pass(d).generic.secondaryFields[0].label = 'T'),
    );
    expect(kinds(r)).toEqual({ 'fields:tier/label': 'both-changed' });
  });
  it('delete against modify', () => {
    const del = (d: any) => d.passJson.generic.secondaryFields.shift();
    const mod = (d: any) => (d.passJson.generic.secondaryFields[0].label = 'T');
    expect(kinds(run(del, mod))).toEqual({
      'fields:tier': 'delete-modify',
      'references:field/tier/bindings/1': 'reference',
    });
    expect(kinds(run(mod, del))).toEqual({ 'fields:tier': 'modify-delete' });
    expect(run(del, del).status).toBe('clean');
  });
  it('moves a field between groups and conflicts on both moving it differently', () => {
    const to = (g: string) => (d: any) => {
      const [f] = pass(d).generic.secondaryFields.splice(0, 1);
      pass(d).generic[g] = [...(pass(d).generic[g] ?? []), f];
    };
    const r = run(undefined, to('auxiliaryFields'));
    expect(style(r).auxiliaryFields.map((f: any) => f.key)).toEqual(['tier']);
    expect(style(r).secondaryFields.map((f: any) => f.key)).toEqual(['pts', 'since']);
    expect(kinds(run(to('backFields'), to('auxiliaryFields')))).toEqual({
      'fields:tier/group': 'both-changed',
    });
  });
  it('takes theirs reorder when ours did not reorder; conflicts when both did differently', () => {
    const swap = (d: any) => pass(d).generic.secondaryFields.reverse();
    const r = run(undefined, swap);
    expect(style(r).secondaryFields.map((f: any) => f.key)).toEqual(['since', 'pts', 'tier']);
    expect(r.theirs).toContainEqual({ part: 'fields', path: [], op: 'move' });
  });
  it('flags an order conflict when both reordered common items differently', () => {
    const r = run(
      (d) => pass(d).generic.secondaryFields.push(pass(d).generic.secondaryFields.shift()),
      (d) => pass(d).generic.secondaryFields.reverse(),
    );
    expect(kinds(r)).toEqual({ 'fields:#order': 'order' });
    expect(style(r).secondaryFields.map((f: any) => f.key)).toEqual(['pts', 'since', 'tier']);
    const theirs = applyResolutions(baseDoc(), r.merged, r.merged, {});
    expect(theirs).toBeDefined();
    const clean = run(
      (d) => pass(d).generic.secondaryFields.reverse(),
      (d) => pass(d).generic.secondaryFields.reverse(),
    );
    expect(clean.status).toBe('clean');
  });
});

describe('barcodes, featuredActions, relevance, nfc', () => {
  it('barcodes merge by index and property', () => {
    const r = run(
      (d) => (pass(d).barcodes[0].message = 'o'),
      (d) => (pass(d).barcodes[0].altText = 't'),
    );
    expect(pass(r.merged).barcodes[0]).toMatchObject({ message: 'o', altText: 't' });
  });
  it('conflicts when both change the barcode count differently', () => {
    const add = (n: number) => (d: any) => {
      for (let i = 0; i < n; i++)
        pass(d).barcodes.push({ format: 'PKBarcodeFormatPDF417', message: String(i) });
    };
    expect(ids(run(add(1), add(2)))).toEqual(['barcodes:barcodes']);
    expect(pass(run(undefined, add(1)).merged).barcodes).toHaveLength(2);
  });
  it('featuredActions merge by identifier', () => {
    const r = run(
      (d) => (pass(d).featuredActions[0].title = 'O'),
      (d) => pass(d).featuredActions.push({ identifier: 'map', title: 'Map' }),
    );
    expect(pass(r.merged).featuredActions.map((a: any) => a.identifier)).toEqual(['call', 'map']);
  });
  it('relevance is a set; maxDistance is K3', () => {
    const r = run(
      (d) => pass(d).locations.push({ latitude: 3, longitude: 4 }),
      (d) => {
        pass(d).locations.push({ latitude: 5, longitude: 6 });
        pass(d).maxDistance = 100;
      },
    );
    expect(pass(r.merged).locations).toHaveLength(3);
    expect(pass(r.merged).maxDistance).toBe(100);
    const rm = run(undefined, (d) => (pass(d).locations = []));
    expect(pass(rm.merged).locations).toEqual([]);
  });
  it('pass nfc is atomic', () => {
    expect(
      ids(
        run(
          (d) => (pass(d).nfc = { message: 'a' }),
          (d) => (pass(d).nfc = { message: 'b' }),
        ),
      ),
    ).toEqual(['pass.nfc:']);
    expect(man(run()).name).toBe('Base');
  });
});
