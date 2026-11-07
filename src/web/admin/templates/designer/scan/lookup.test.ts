import { describe, expect, it } from 'vitest';
import { scanIssues } from '../../../../../passkit/template/scan.ts';
import type { TemplateManifest } from '../../../../../passkit/types.ts';
import { applyOp } from '../apply.ts';
import { sampleDoc } from '../fixtures.ts';
import { lookupInput, lookupInputs } from './lookup.ts';

describe('independent lookup IDs', () => {
  it('configures an input without changing visible fields, barcode data or existing scan policies', () => {
    const doc = sampleDoc();
    doc.manifest.scan = {
      actions: [{ id: 'enter', label: 'Enter', kind: 'check_in', repeat: 'always' }],
    };
    const next = applyOp(doc, { op: 'scan-lookup', input: 'name' });
    expect(next.passJson).toEqual(doc.passJson);
    expect(next.manifest.scan).toEqual({
      ...(doc.manifest.scan as object),
      lookup: { input: 'name' },
    });
    expect(scanIssues(next.manifest as unknown as TemplateManifest)).toEqual([]);
  });

  it('adds the standard check-in action when a template has no scan block', () => {
    const next = applyOp(sampleDoc(), { op: 'scan-lookup', input: 'name' });
    expect(lookupInput(next.manifest)).toBe('name');
    expect(scanIssues(next.manifest as unknown as TemplateManifest)).toEqual([]);
    expect(lookupInput(applyOp(next, { op: 'scan-lookup', input: '' }).manifest)).toBe('');
  });

  it('follows renames and clears removed or incompatible inputs', () => {
    const doc = applyOp(sampleDoc(), { op: 'scan-lookup', input: 'name' });
    const renamed = applyOp(doc, { op: 'input-set', name: 'name', patch: { name: 'memberId' } });
    expect(lookupInput(renamed.manifest)).toBe('memberId');
    expect(lookupInput(applyOp(renamed, { op: 'input-remove', name: 'memberId' }).manifest)).toBe(
      '',
    );
    expect(
      lookupInput(
        applyOp(doc, { op: 'input-set', name: 'name', patch: { type: 'boolean' } }).manifest,
      ),
    ).toBe('');
  });

  it('offers only declared strings and integers and rejects an invalid selection', () => {
    const doc = sampleDoc();
    doc.manifest.inputs = {
      properties: {
        id: { type: 'integer' },
        name: { type: 'string' },
        decimal: { type: 'number' },
        flag: { type: 'boolean' },
      },
    };
    expect(lookupInputs(doc.manifest).map((s) => s.value)).toEqual(['id', 'name']);
    expect(applyOp(doc, { op: 'scan-lookup', input: 'decimal' })).toBe(doc);
    expect(applyOp(doc, { op: 'scan-lookup', input: 'missing' })).toBe(doc);
  });
});
