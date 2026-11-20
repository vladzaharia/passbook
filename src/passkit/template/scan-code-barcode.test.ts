import { describe, expect, it } from 'vitest';
import type { TemplateManifest } from '../types.ts';
import { barcodeIsScanCode } from './scan-code-barcode.ts';

const manifest = (bindings: unknown[]): TemplateManifest =>
  ({ schema: 1, name: 't', inputs: { type: 'object' }, bindings }) as TemplateManifest;
const code = { to: { barcode: 0, prop: 'message' }, value: '{{pass.scanCode}}' };

describe('barcodeIsScanCode', () => {
  it('accepts one unconditional scan-code message, with or without spaces', () => {
    expect(barcodeIsScanCode(manifest([code]))).toBe(true);
    expect(barcodeIsScanCode(manifest([{ ...code, value: ' {{pass.scanCode}} ' }]))).toBe(true);
    expect(barcodeIsScanCode(manifest([{ ...code, to: { barcode: '*', prop: 'message' } }]))).toBe(
      true,
    );
  });

  it('refuses no barcode, another value, a conditional one, or one that reads an input', () => {
    expect(barcodeIsScanCode(manifest([]))).toBe(false);
    expect(barcodeIsScanCode(manifest([{ ...code, value: '{{memberNo}}' }]))).toBe(false);
    expect(barcodeIsScanCode(manifest([{ ...code, value: 'A-{{pass.scanCode}}' }]))).toBe(false);
    expect(
      barcodeIsScanCode(manifest([{ ...code, when: { input: 'tier', equals: 'gold' } }])),
    ).toBe(false);
  });

  it('judges the last message binding, as the join readiness does', () => {
    expect(barcodeIsScanCode(manifest([{ ...code, value: 'x' }, code]))).toBe(true);
  });
});
