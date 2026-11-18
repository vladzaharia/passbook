import { readdirSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const slugs = readdirSync('templates').filter((d) => d.startsWith('starter-'));

describe('blueprint barcodes', () => {
  it('finds the blueprints', () => expect(slugs.length).toBeGreaterThanOrEqual(8));

  it.each(slugs)('%s carries the scan code, so a copy of it can be replaced', (slug) => {
    const t = JSON.parse(readFileSync(`templates/${slug}/wallet.template.json`, 'utf8')) as {
      bindings: { to: { barcode?: string; prop?: string }; value: string }[];
    };
    const messages = t.bindings.filter(
      (b) => b.to.barcode !== undefined && b.to.prop === 'message',
    );
    expect(messages.map((b) => b.value)).toEqual(['{{pass.scanCode}}']);
  });
});
