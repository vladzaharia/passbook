import { describe, expect, it } from 'vitest';
import { applyOp, type Op } from './apply.ts';
import {
  bindBarcode,
  bindField,
  dropFieldBindings,
  dropInputRefs,
  exprOf,
  inputUses,
  mapInputRefs,
  readsInput,
  renameFieldBindings,
  renameInputRefs,
} from './bindings.ts';
import { sampleDoc } from './fixtures.ts';
import { nameProblem } from './inputs.ts';
import { type DesignDoc, fieldsOf } from './model.ts';
import { readBarcode } from './ops-more.ts';
import { anchorOf } from './ops-pass.ts';
import { designerReducer, initialState, isDirty } from './reducer.ts';

const run = (doc: DesignDoc, ...ops: Op[]) => ops.reduce(applyOp, doc);

describe('input references', () => {
  it('finds and renames every way an expression reads an input', () => {
    const rename = (text: string) => mapInputRefs(text, (n) => (n === 'name' ? 'full' : n));
    expect(rename('{{name}}')).toBe('{{full}}');
    expect(rename('{{ name }}')).toBe('{{ full }}');
    expect(rename('{{name.first}}')).toBe('{{full.first}}');
    expect(rename('{{name | html}}')).toBe('{{full | html}}');
    expect(rename('{{lookups.tier[name]}}')).toBe('{{lookups.tier[full]}}');
    expect(rename('{{ lookups.tier[ name ] }}')).toBe('{{ lookups.tier[ full ] }}');
    expect(rename('{{pass.scanCode}} {{other}}')).toBe('{{pass.scanCode}} {{other}}');
    expect(rename('{{names}}')).toBe('{{names}}');
  });

  it('knows which forms read an input', () => {
    for (const text of [
      '{{name}}',
      '{{ name }}',
      '{{name.x}}',
      '{{lookups.t[name]}}',
      'A {{name|url}}',
    ])
      expect(readsInput(text, 'name')).toBe(true);
    for (const text of ['{{names}}', '{{lookups.name}}', 'name', '{{pass.name}}'])
      expect(readsInput(text, 'name')).toBe(false);
  });

  it('removes bindings that read an input in any form', () => {
    const manifest = {
      bindings: [
        { to: { field: 'a' }, value: '{{ name }}' },
        { to: { field: 'b' }, value: '{{lookups.t[name]}}' },
        { to: { field: 'c' }, value: '{{name.x}}' },
        { to: { field: 'd' }, value: '{{other}}' },
      ],
    };
    expect(dropInputRefs(manifest, 'name')).toEqual([{ to: { field: 'd' }, value: '{{other}}' }]);
    expect(inputUses(manifest, 'name')).toEqual({ fields: 3, messaging: false });
    expect(inputUses({ ...manifest, messaging: { input: 'name' } }, 'name').messaging).toBe(true);
  });

  it('renames through display and bindings', () => {
    const next = renameInputRefs(
      { bindings: [{ to: { field: 'a' }, value: '{{ name }}' }], display: { title: '{{name.x}}' } },
      'name',
      'full',
    );
    expect(next.bindings).toEqual([{ to: { field: 'a' }, value: '{{ full }}' }]);
    expect(next.display).toMatchObject({ title: '{{full.x}}' });
  });

  it('keeps a field rename and removal right for array targets', () => {
    const manifest = { bindings: [{ to: { field: ['a', 'b'] }, value: '{{x}}' }] };
    expect(renameFieldBindings(manifest, 'a', 'z')[0]?.to).toEqual({ field: ['z', 'b'] });
    expect(dropFieldBindings(manifest, 'a')[0]?.to).toEqual({ field: 'b' });
    expect(dropFieldBindings({ bindings: [{ to: { field: ['a'] }, value: 'x' }] }, 'a')).toEqual(
      [],
    );
  });

  it('rejects names the expression engine refuses', () => {
    for (const name of ['pass', 'constructor', 'prototype'])
      expect(nameProblem(name, [])).toMatch(/reserved/);
    expect(nameProblem('member', [])).toBeNull();
  });
});

describe('clearing a custom expression', () => {
  it('keeps an empty expression bound instead of dropping the binding', () => {
    expect(exprOf({ kind: 'expr', expr: '' })).toBe('');
    const bindings = bindField({ bindings: [] }, 'name', { kind: 'expr', expr: '' });
    expect(bindings).toEqual([{ to: { field: 'name' }, value: '' }]);
    expect(bindBarcode({ bindings: [] }, 'message', { kind: 'expr', expr: '' })).toHaveLength(1);
    expect(bindField({ bindings }, 'name', { kind: 'static' })).toEqual([]);
  });
});

describe('static barcode message', () => {
  it('can be cleared', () => {
    const doc = sampleDoc();
    const next = run(doc, {
      op: 'barcode',
      settings: { ...readBarcode(doc), staticMessage: '' },
    });
    expect(readBarcode(next).staticMessage).toBe('');
  });
});

describe('static links', () => {
  it('escapes the text and links only safe schemes', () => {
    expect(anchorOf('https://a.test/?q="x"&y=<b>')).toBe(
      '<a href="https://a.test/?q=&quot;x&quot;&amp;y=&lt;b&gt;">https://a.test/?q=&quot;x&quot;&amp;y=&lt;b&gt;</a>',
    );
    expect(anchorOf('tel:+1555')).toContain('<a href="tel:+1555">');
    expect(anchorOf('javascript:alert(1)')).toBe('javascript:alert(1)');
    expect(anchorOf('"><script>')).toBe('&quot;&gt;&lt;script&gt;');
  });
});

describe('saving while editing', () => {
  it('moves only the baseline when the document changed during the save', () => {
    let s = initialState(sampleDoc());
    s = designerReducer(s, { type: 'edit', op: { op: 'pass-prop', key: 'logoText', value: 'A' } });
    const snapshot = s.doc;
    s = designerReducer(s, { type: 'edit', op: { op: 'pass-prop', key: 'logoText', value: 'AB' } });
    s = designerReducer(s, { type: 'saved', snapshot, doc: snapshot });
    expect(s.doc.passJson.logoText).toBe('AB');
    expect(s.saved.passJson.logoText).toBe('A');
    expect(isDirty(s)).toBe(true);
  });

  it('resets when nothing changed, and gives sent files the server hash', () => {
    const doc = sampleDoc();
    doc.assets.push({ name: 'logo@3x.png', slot: 'logo', scale: 3, size: 3, upload: 'QQ==' });
    let s = initialState(doc, sampleDoc());
    const stored = {
      ...doc,
      assets: doc.assets.map((a) => ({ ...a, upload: undefined, sha1: 'b'.repeat(40) })),
    };
    // Edited during the save: the file is untouched, so it takes the hash and stays clean.
    const snapshot = s.doc;
    s = designerReducer(s, { type: 'edit', op: { op: 'pass-prop', key: 'logoText', value: 'Q' } });
    s = designerReducer(s, { type: 'saved', snapshot, doc: stored });
    expect(s.doc.assets.find((a) => a.slot === 'logo')?.upload).toBeUndefined();
    s = designerReducer(initialState(doc, sampleDoc()), {
      type: 'saved',
      snapshot: doc,
      doc: stored,
    });
    expect(isDirty(s)).toBe(false);
    expect(fieldsOf(s.doc.passJson, 'primaryFields')).toHaveLength(1);
  });
});
