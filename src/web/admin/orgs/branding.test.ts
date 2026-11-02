import { describe, expect, it } from 'vitest';
import { accentWarnings, hexOf, imageSizeError, passColorWarnings, pngSize } from './branding.ts';

describe('branding checks', () => {
  it('warns on pass colours under 4.5:1 text and 3:1 labels', () => {
    expect(
      passColorWarnings({ background: '#ffffff', foreground: '#eeeeee', label: '#000000' }),
    ).toEqual(['Text on the background is 1.2:1; Apple asks for 4.5:1.']);
    expect(
      passColorWarnings({ background: '#0f172a', foreground: '#ffffff', label: '#94a3b8' }),
    ).toEqual([]);
  });

  it('warns when the accent is weak on the white email ground', () => {
    expect(accentWarnings('#d97706')).toEqual([
      'Links in emails are 3.2:1 on white; aim for 4.5:1.',
    ]);
    expect(accentWarnings('#0f766e')).toEqual([]);
    expect(accentWarnings('#ffff00')).toHaveLength(1);
  });

  it('checks @3x sizes against the passkit rules', () => {
    expect(imageSizeError('icon', 100, 100)).toBe(
      'The icon is 100x100px; use 114x114px or 87x87px.',
    );
    expect(imageSizeError('icon', 114, 114)).toBeUndefined();
    expect(imageSizeError('logo', 480, 150)).toBeUndefined();
    expect(imageSizeError('logo', 481, 150)).toMatch(/at most 480x150px/);
  });

  it('reads the PNG size from the header', () => {
    const bytes = new Uint8Array(24);
    bytes.set([137, 80, 78, 71, 13, 10, 26, 10]);
    new DataView(bytes.buffer).setUint32(16, 114);
    new DataView(bytes.buffer).setUint32(20, 87);
    expect(pngSize(bytes)).toEqual({ w: 114, h: 87 });
    expect(pngSize(new Uint8Array(24))).toBeUndefined();
  });
});

describe('hexOf', () => {
  it('reads pass.json rgb() and hex, and nothing else', () => {
    expect(hexOf('rgb(15, 23, 42)')).toBe('#0f172a');
    expect(hexOf('#ABCDEF')).toBe('#ABCDEF');
    expect(hexOf('teal')).toBeUndefined();
  });
});
