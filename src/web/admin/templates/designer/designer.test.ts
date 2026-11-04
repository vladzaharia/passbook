import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { PassJson, TemplateManifest } from '@/passkit/types.ts';
import { validateManifest } from '../../../../passkit/template/manifest.ts';
import { applyOp, type Op } from './apply.ts';
import { fieldSource } from './bindings.ts';
import { sampleDoc } from './fixtures.ts';
import { newInput, readInputs } from './inputs.ts';
import { type DesignDoc, fieldsOf, keyOf, styleOf } from './model.ts';
import { readBarcode } from './ops-more.ts';
import {
  type Action,
  canRedo,
  canUndo,
  designerReducer,
  initialState,
  isDirty,
  validSelection,
} from './reducer.ts';

const run = (doc: DesignDoc, ...ops: Op[]) => ops.reduce(applyOp, doc);
const errors = (doc: DesignDoc) =>
  validateManifest(doc.manifest as unknown as TemplateManifest, {
    passJson: doc.passJson as unknown as PassJson,
  })
    // Baked starters use `pattern`, which uploads may not; the designer never writes it.
    .filter((i) => i.severity === 'error' && i.code !== 'SCHEMA_KEYWORD');
const keys = (doc: DesignDoc, group: 'secondaryFields' | 'primaryFields' | 'backFields') =>
  fieldsOf(doc.passJson, group).map(keyOf);

describe('document ops', () => {
  it('does not change the document it was given', () => {
    const doc = sampleDoc();
    const before = JSON.stringify(doc);
    run(doc, { op: 'field-add', group: 'headerFields' }, { op: 'style', style: 'coupon' });
    expect(JSON.stringify(doc)).toBe(before);
  });

  it('adds, moves, nudges and removes fields', () => {
    let doc = run(sampleDoc(), { op: 'field-add', group: 'secondaryFields', key: 'extra' });
    expect(keys(doc, 'secondaryFields')).toEqual(['tier', 'since', 'extra']);
    doc = run(doc, { op: 'field-nudge', key: 'extra', delta: -1 });
    expect(keys(doc, 'secondaryFields')).toEqual(['tier', 'extra', 'since']);
    expect(run(doc, { op: 'field-nudge', key: 'tier', delta: -1 })).toBe(doc);
    doc = run(doc, { op: 'field-move', key: 'extra', group: 'backFields', index: 0 });
    expect(keys(doc, 'backFields')).toEqual(['extra', 'terms']);
    doc = run(doc, { op: 'field-remove', key: 'name' });
    expect(keys(doc, 'primaryFields')).toEqual([]);
    expect(doc.manifest.bindings).toEqual([]);
  });

  it('keeps fields when the style changes, moving unsupported groups to the back', () => {
    const doc = run(
      sampleDoc(),
      { op: 'field-add', group: 'secondaryFields', key: 'x' },
      { op: 'style', style: 'posterGeneric' },
    );
    expect(styleOf(doc.passJson)).toBe('posterGeneric');
    expect(doc.passJson.generic).toBeUndefined();
    expect(keys(doc, 'secondaryFields')).toContain('x');
    const boarding = run(doc, { op: 'style', style: 'boardingPass' });
    expect((boarding.passJson.boardingPass as Record<string, unknown>).transitType).toBe(
      'PKTransitTypeGeneric',
    );
    expect(errors(boarding)).toEqual([]);
  });

  it('turns the poster scheme on and off', () => {
    const doc = run(sampleDoc(), { op: 'style', style: 'eventTicket' }, { op: 'poster', on: true });
    expect(doc.passJson.preferredStyleSchemes).toEqual(['posterEventTicket', 'eventTicket']);
    expect(run(doc, { op: 'poster', on: false }).passJson.preferredStyleSchemes).toBeUndefined();
  });

  it('renames a field key and its bindings', () => {
    const doc = run(sampleDoc(), { op: 'field-key', key: 'name', to: 'member' });
    expect(keys(doc, 'primaryFields')).toEqual(['member']);
    expect(fieldSource(doc.manifest, 'member')).toEqual({ kind: 'input', name: 'name' });
    expect(run(doc, { op: 'field-key', key: 'member', to: 'tier' })).toBe(doc);
  });

  it('writes link fields with a matching anchor binding', () => {
    let doc = run(
      sampleDoc(),
      {
        op: 'input-add',
        spec: { ...newInput(readInputs(sampleDoc().manifest), 'url'), name: 'site' },
      },
      { op: 'field-add', group: 'backFields', key: 'web' },
      { op: 'field-source', key: 'web', source: { kind: 'input', name: 'site' }, optional: true },
      { op: 'field-link', key: 'web', on: true, optional: true },
    );
    expect(fieldSource(doc.manifest, 'web', 'attributedValue')).toEqual({
      kind: 'expr',
      expr: '<a href="{{site|html}}">{{site|html}}</a>',
    });
    expect(errors(doc)).toEqual([]);
    doc = run(doc, { op: 'field-link', key: 'web', on: false, optional: true });
    expect(fieldSource(doc.manifest, 'web', 'attributedValue')).toEqual({ kind: 'static' });
  });
});

describe('inputs editor', () => {
  it('generates inputs, sample and bindings that validate', () => {
    const base = sampleDoc();
    const doc = run(
      base,
      {
        op: 'input-add',
        spec: {
          name: 'seat',
          label: 'Seat',
          type: 'text',
          required: false,
          default: 'Open',
          sample: 'A1',
        },
      },
      {
        op: 'input-add',
        spec: {
          name: 'when',
          label: 'When',
          type: 'datetime',
          required: true,
          default: '',
          sample: '2030-06-01T19:00:00-07:00',
        },
      },
      {
        op: 'input-add',
        spec: {
          name: 'qty',
          label: 'Quantity',
          type: 'number',
          required: false,
          default: '2',
          sample: '3',
        },
      },
      {
        op: 'input-add',
        spec: {
          name: 'vip',
          label: 'VIP',
          type: 'boolean',
          required: false,
          default: '',
          sample: 'true',
        },
      },
      { op: 'field-source', key: 'tier', source: { kind: 'input', name: 'seat' }, optional: true },
      { op: 'display', part: 'subtitle', expr: '{{seat}}' },
    );
    const props = (doc.manifest.inputs as { properties: Record<string, Record<string, unknown>> })
      .properties;
    expect(props.seat).toMatchObject({ type: 'string', default: 'Open', 'x-label': 'Seat' });
    expect(props.when).toMatchObject({ format: 'date-time', minLength: 1 });
    expect(props.qty).toMatchObject({ type: 'number', default: 2 });
    expect(props.vip).toMatchObject({ type: 'boolean' });
    expect((doc.manifest.inputs as { required: string[] }).required).toEqual(['name', 'when']);
    expect(doc.manifest.sample).toEqual({
      name: 'Alex',
      seat: 'A1',
      when: '2030-06-01T19:00:00-07:00',
      qty: 3,
      vip: true,
    });
    expect(doc.manifest.bindings).toContainEqual({
      to: { field: 'tier' },
      value: '{{seat}}',
      omitIfEmpty: true,
    });
    expect(errors(doc)).toEqual([]);
    expect(readInputs(doc.manifest).map((s) => s.name)).toEqual([
      'name',
      'seat',
      'when',
      'qty',
      'vip',
    ]);
  });

  it('renames an input everywhere it is read, and refuses a taken name', () => {
    const doc = run(sampleDoc(), { op: 'input-set', name: 'name', patch: { name: 'member' } });
    expect(doc.manifest.bindings).toEqual([{ to: { field: 'name' }, value: '{{member}}' }]);
    expect(doc.manifest.display).toMatchObject({ title: '{{member}}' });
    expect(doc.manifest.sample).toEqual({ member: 'Alex' });
    expect(errors(doc)).toEqual([]);
    const two = run(doc, { op: 'input-add', spec: newInput(readInputs(doc.manifest)) });
    expect(run(two, { op: 'input-set', name: 'input2', patch: { name: 'member' } })).toBe(two);
  });

  it('removes an input with its bindings and keeps a title', () => {
    const doc = run(
      sampleDoc(),
      {
        op: 'input-add',
        spec: { name: 'b', label: 'B', type: 'text', required: false, default: '', sample: 'x' },
      },
      { op: 'input-remove', name: 'name' },
    );
    expect(doc.manifest.bindings).toEqual([]);
    expect(doc.manifest.display).toMatchObject({ title: '{{b}}' });
    expect(errors(doc)).toEqual([]);
  });

  it('reorders inputs', () => {
    const doc = run(
      sampleDoc(),
      { op: 'input-add', spec: newInput(readInputs(sampleDoc().manifest)) },
      { op: 'input-move', name: 'input2', to: 0 },
    );
    expect(readInputs(doc.manifest).map((s) => s.name)).toEqual(['input2', 'name']);
  });
});

describe('barcode', () => {
  it('binds the message to an input or the scan code', () => {
    const base = sampleDoc();
    const s = readBarcode(base);
    expect(s).toMatchObject({
      enabled: true,
      format: 'PKBarcodeFormatQR',
      message: { kind: 'static' },
    });
    const scan = run(base, { op: 'barcode', settings: { ...s, message: { kind: 'scanCode' } } });
    expect(scan.manifest.bindings).toContainEqual({
      to: { barcode: '*', prop: 'message' },
      value: '{{pass.scanCode}}',
    });
    expect(readBarcode(scan).message).toEqual({ kind: 'scanCode' });
    expect(errors(scan)).toEqual([]);
    const off = run(scan, { op: 'barcode', settings: { ...s, enabled: false } });
    expect(off.passJson.barcodes).toBeUndefined();
    expect((off.manifest.bindings as unknown[]).length).toBe(1);
  });
});

describe('assets', () => {
  it('replaces a slot and drops it', () => {
    const asset = { name: 'logo@3x.png', slot: 'logo', scale: 3 as const, size: 5, upload: 'AAAA' };
    const doc = run(sampleDoc(), { op: 'image', slot: 'logo', asset });
    expect(doc.assets.map((a) => a.name)).toEqual(['icon@3x.png', 'logo@3x.png']);
    expect(run(doc, { op: 'image', slot: 'logo', asset: null }).assets).toHaveLength(1);
  });
});

describe('starters stay valid after edits', () => {
  for (const slug of [
    'generic',
    'coupon',
    'event-ticket',
    'store-card',
    'boarding-pass',
    'poster-generic',
  ]) {
    it(`starter-${slug}`, () => {
      const dir = join(process.cwd(), 'templates', `starter-${slug}`);
      const doc: DesignDoc = {
        passJson: JSON.parse(readFileSync(join(dir, 'pass.json'), 'utf8')),
        manifest: JSON.parse(readFileSync(join(dir, 'wallet.template.json'), 'utf8')),
        assets: [],
      };
      expect(errors(doc)).toEqual([]);
      const edited = run(
        doc,
        { op: 'input-add', spec: newInput(readInputs(doc.manifest)) },
        { op: 'field-add', group: 'backFields', key: 'added' },
        {
          op: 'field-source',
          key: 'added',
          source: { kind: 'input', name: `input${readInputs(doc.manifest).length + 1}` },
          optional: true,
        },
        { op: 'pass-prop', key: 'logoText', value: 'Hello' },
      );
      expect(errors(edited)).toEqual([]);
    });
  }
});

describe('history', () => {
  const at = (n: number) => ({ at: n });
  const edit = (op: Op, merge?: string, n = 0): Action => ({
    type: 'edit',
    op,
    ...(merge ? { merge } : {}),
    ...at(n),
  });
  const step = (s: ReturnType<typeof initialState>, ...a: Action[]) => a.reduce(designerReducer, s);

  it('undoes and redoes, and a new edit clears redo', () => {
    let s = initialState(sampleDoc());
    expect(canUndo(s)).toBe(false);
    s = step(
      s,
      edit({ op: 'pass-prop', key: 'logoText', value: 'A' }),
      edit({ op: 'pass-prop', key: 'logoText', value: 'B' }),
    );
    expect(s.doc.passJson.logoText).toBe('B');
    s = step(s, { type: 'undo' });
    expect(s.doc.passJson.logoText).toBe('A');
    expect(canRedo(s)).toBe(true);
    s = step(s, { type: 'redo' });
    expect(s.doc.passJson.logoText).toBe('B');
    s = step(s, { type: 'undo' }, edit({ op: 'pass-prop', key: 'logoText', value: 'C' }));
    expect(canRedo(s)).toBe(false);
  });

  it('merges typing into one step, but not after a pause or another target', () => {
    let s = initialState(sampleDoc());
    s = step(
      s,
      edit({ op: 'pass-prop', key: 'logoText', value: 'H' }, 'logoText', 0),
      edit({ op: 'pass-prop', key: 'logoText', value: 'He' }, 'logoText', 300),
      edit({ op: 'pass-prop', key: 'logoText', value: 'Hel' }, 'logoText', 600),
    );
    expect(s.past).toHaveLength(1);
    s = step(s, edit({ op: 'pass-prop', key: 'logoText', value: 'Hell' }, 'logoText', 5000));
    expect(s.past).toHaveLength(2);
    s = step(s, edit({ op: 'pass-prop', key: 'groupingIdentifier', value: 'x' }, 'group', 5100));
    expect(s.past).toHaveLength(3);
    s = step(s, { type: 'undo' });
    expect(s.doc.passJson.groupingIdentifier).toBeUndefined();
  });

  it('is dirty only while the document differs from the saved one', () => {
    let s = initialState(sampleDoc());
    expect(isDirty(s)).toBe(false);
    s = step(s, edit({ op: 'pass-prop', key: 'logoText', value: 'A' }));
    expect(isDirty(s)).toBe(true);
    s = step(s, edit({ op: 'pass-prop', key: 'logoText', value: 'Org' }));
    expect(isDirty(s)).toBe(false);
    s = step(s, edit({ op: 'pass-prop', key: 'logoText', value: 'Z' }));
    s = step(s, { type: 'saved', doc: s.doc });
    expect(isDirty(s)).toBe(false);
    s = step(s, edit({ op: 'pass-prop', key: 'logoText', value: 'Y' }));
    expect(isDirty(s)).toBe(true);
    s = step(s, { type: 'undo' });
    expect(isDirty(s)).toBe(false);
  });

  it('ignores edits that change nothing and keeps the selection on something real', () => {
    let s = initialState(sampleDoc());
    expect(step(s, edit({ op: 'field-remove', key: 'nope' }))).toBe(s);
    s = step(
      s,
      { type: 'select', select: { section: 'secondaryFields', key: 'tier' } },
      edit({ op: 'field-remove', key: 'tier' }),
    );
    expect(validSelection(s)).toEqual({ section: 'secondaryFields' });
  });

  it('numbers an added field so it can take focus', () => {
    const s = designerReducer(initialState(sampleDoc()), {
      type: 'edit',
      op: { op: 'field-add', group: 'headerFields' },
    });
    expect(s.added).toMatchObject({ kind: 'field', n: 1 });
    expect(keys(s.doc, 'primaryFields')).toEqual(['name']);
    expect(fieldsOf(s.doc.passJson, 'headerFields').map(keyOf)).toEqual([s.added?.key]);
  });

  it('caps the history', () => {
    let s = initialState(sampleDoc());
    for (let i = 0; i < 130; i++)
      s = step(s, edit({ op: 'pass-prop', key: 'logoText', value: `v${i}` }));
    expect(s.past).toHaveLength(100);
  });
});
