import { describe, expect, it } from 'vitest';
import type { TemplateManifest } from '../../../../passkit/types.ts';
import { buildKey } from './hash.ts';

const scan: NonNullable<TemplateManifest['scan']> = {
  actions: [{ id: 'check_in', label: 'Check in', kind: 'check_in' }],
  display: { v: 1, header: { subtitle: 'Before' } },
};
const manifest: TemplateManifest = {
  schema: 1,
  name: 'Card',
  description: 'First description',
  inputs: { type: 'object', properties: { name: { type: 'string' } } },
  sample: { name: 'Alex' },
  bindings: [],
  display: { title: '{{name}}' },
  previewOnlyAssets: ['preview.png'],
  scan,
};
const icon = { name: 'icon.png', sha1: 'a'.repeat(40) };
const preview = { name: 'preview.png', sha1: 'b'.repeat(40) };
const assets = [icon, preview];
const passJson = { generic: { primaryFields: [{ key: 'name', value: 'Alex' }] }, formatVersion: 1 };

describe('template build key', () => {
  it('canonicalizes documents and ignores scan display, description, and preview-only content', async () => {
    const original = await buildKey({ manifest, assets, passJson });
    const reordered = await buildKey({
      passJson: { formatVersion: 1, generic: { primaryFields: [{ value: 'Alex', key: 'name' }] } },
      assets: [{ ...preview, sha1: 'c'.repeat(40) }, icon],
      manifest: {
        ...manifest,
        description: 'A different description',
        scan: { ...scan, display: { v: 1, header: { subtitle: 'After' } } },
      },
    });
    expect(original).toMatch(/^[0-9a-f]{64}$/);
    expect(reordered).toBe(original);
  });

  it('changes when a pass, shipped asset, or other manifest content changes', async () => {
    const original = await buildKey({ manifest, assets, passJson });
    expect(
      await buildKey({ manifest, assets, passJson: { ...passJson, formatVersion: 2 } }),
    ).not.toBe(original);
    expect(
      await buildKey({
        manifest,
        passJson,
        assets: [{ ...icon, sha1: 'c'.repeat(40) }, preview],
      }),
    ).not.toBe(original);
    expect(
      await buildKey({ manifest: { ...manifest, name: 'Other card' }, assets, passJson }),
    ).not.toBe(original);
    expect(
      await buildKey({
        manifest: {
          ...manifest,
          scan: {
            ...scan,
            actions: [{ id: 'check_in', label: 'Admit', kind: 'check_in' }],
          },
        },
        assets,
        passJson,
      }),
    ).not.toBe(original);
  });

  it('accounts for preview-only membership when it changes the shipped files', async () => {
    const original = await buildKey({ manifest, assets, passJson });
    expect(
      await buildKey({ manifest: { ...manifest, previewOnlyAssets: [] }, assets, passJson }),
    ).not.toBe(original);
    expect(
      await buildKey({
        manifest: { ...manifest, previewOnlyAssets: ['preview.png', 'missing.png'] },
        assets,
        passJson,
      }),
    ).toBe(original);
  });
});
