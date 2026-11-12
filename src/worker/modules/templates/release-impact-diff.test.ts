import { describe, expect, it } from 'vitest';
import type { AssetEntry, PassJson } from '../../../passkit/types.ts';
import { versionDiff } from './release-impact-diff.ts';

const pass = (over: Record<string, unknown> = {}): PassJson =>
  ({
    formatVersion: 1,
    passTypeIdentifier: 'pass.test',
    teamIdentifier: 'TEAM',
    serialNumber: 's',
    organizationName: 'Org',
    description: 'd',
    generic: {
      primaryFields: [{ key: 'name', label: 'Member', value: '{{name}}' }],
      backFields: [{ key: 'terms', value: 'Be kind' }],
    },
    backgroundColor: 'rgb(0, 0, 0)',
    barcodes: [{ format: 'PKBarcodeFormatQR', message: '{{id}}', messageEncoding: 'iso-8859-1' }],
    ...over,
  }) as unknown as PassJson;

const image = (name: string, sha1: string, width = 29): AssetEntry => ({
  name,
  slot: 'icon',
  scale: 1,
  size: 10,
  sha1,
  crc32: 0,
  width,
  height: width,
  source: { kind: 'inline' },
});

describe('versionDiff', () => {
  it('is empty for equal versions', () => {
    const v = { passJson: pass(), assets: [image('icon.png', 'a')] };
    expect(versionDiff(v, v).diff).toEqual({ fields: [], images: [], barcode: [], colors: [] });
  });

  it('reports field, image, barcode and colour changes with both sides', () => {
    const from = { passJson: pass(), assets: [image('icon.png', 'a'), image('logo.png', 'l')] };
    const to = {
      passJson: pass({
        generic: {
          primaryFields: [{ key: 'name', label: 'Member', value: '{{fullName}}' }],
          secondaryFields: [{ key: 'tier', label: 'Tier', value: 'Gold' }],
        },
        backgroundColor: 'rgb(255, 0, 0)',
        barcodes: [
          { format: 'PKBarcodeFormatQR', message: '{{serial}}', messageEncoding: 'iso-8859-1' },
        ],
      }),
      assets: [image('icon.png', 'b', 58), image('strip.png', 's')],
    };
    const { diff } = versionDiff(from, to);
    expect(diff.fields).toEqual([
      { label: 'Primary: Member', kind: 'changed', from: '{{name}}', to: '{{fullName}}' },
      { label: 'Secondary: Tier', kind: 'added', from: null, to: 'Gold' },
      { label: 'Back: terms', kind: 'removed', from: 'Be kind', to: null },
    ]);
    expect(diff.images).toEqual([
      { label: 'icon.png', kind: 'changed', from: '29×29', to: '58×58' },
      { label: 'strip.png', kind: 'added', from: null, to: '29×29' },
      { label: 'logo.png', kind: 'removed', from: '29×29', to: null },
    ]);
    expect(diff.barcode).toEqual([
      { label: 'Message', kind: 'changed', from: '{{id}}', to: '{{serial}}' },
    ]);
    expect(diff.colors).toEqual([
      { label: 'Background', kind: 'changed', from: 'rgb(0, 0, 0)', to: 'rgb(255, 0, 0)' },
    ]);
  });

  it('shows everything as added when there is no release yet', () => {
    const { diff } = versionDiff(null, { passJson: pass(), assets: [image('icon.png', 'a')] });
    expect(diff.fields.every((c) => c.kind === 'added')).toBe(true);
    expect(diff.images).toHaveLength(1);
    expect(diff.colors).toEqual([
      { label: 'Background', kind: 'added', from: null, to: 'rgb(0, 0, 0)' },
    ]);
  });

  it('keys fields by their key, reports label edits and ignores equal colours', () => {
    const from = {
      passJson: pass({
        generic: {
          primaryFields: [
            { key: 'a', label: 'Same', value: '1' },
            { key: 'b', label: 'Same', value: '2' },
          ],
        },
        backgroundColor: 'rgb(1,2,3)',
      }),
      assets: [],
    };
    const to = {
      passJson: pass({
        generic: {
          primaryFields: [
            { key: 'a', label: 'Same', value: '1' },
            { key: 'b', label: 'Renamed', value: '2' },
          ],
        },
        backgroundColor: '#010203',
      }),
      assets: [],
    };
    const { diff } = versionDiff(from, to);
    expect(diff.fields).toEqual([
      { label: 'Primary: Renamed (label)', kind: 'changed', from: 'Same', to: 'Renamed' },
    ]);
    expect(diff.colors).toEqual([]);
  });

  it('compares every barcode', () => {
    const code = (message: string) => ({
      format: 'PKBarcodeFormatQR',
      message,
      messageEncoding: 'iso-8859-1',
    });
    const { diff } = versionDiff(
      { passJson: pass({ barcodes: [code('a'), code('b')] }), assets: [] },
      { passJson: pass({ barcodes: [code('a'), code('c')] }), assets: [] },
    );
    expect(diff.barcode).toEqual([
      { label: 'Barcode 2: Message', kind: 'changed', from: 'b', to: 'c' },
    ]);
  });

  it('cuts a list at 50 and says how many more', () => {
    const fields = (n: number) =>
      Array.from({ length: n }, (_, i) => ({ key: `k${i}`, value: 'v' }));
    const { diff, more } = versionDiff(
      { passJson: pass({ generic: { primaryFields: [] } }), assets: [] },
      { passJson: pass({ generic: { primaryFields: fields(60) } }), assets: [] },
    );
    expect(diff.fields).toHaveLength(50);
    expect(more.fields).toBe(10);
  });
});
