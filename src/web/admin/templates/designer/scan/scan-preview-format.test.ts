import { describe, expect, it } from 'vitest';
import { renderScanDisplay } from '@/passkit/template/scan-display/render.ts';
import type { ScanDisplayDoc } from '@/passkit/template/scan-display/schema.ts';
import type { DesignDoc } from '../model.ts';
import { syntheticScope } from './scan-preview.ts';

const NOW = Date.UTC(2026, 5, 1, 12);

function doc(): DesignDoc {
  return {
    assets: [],
    passJson: {
      storeCard: {
        primaryFields: [{ key: 'bal', label: 'Balance', currencyCode: 'USD' }],
        secondaryFields: [{ key: 'since', label: 'Since', dateStyle: 'PKDateStyleMedium' }],
      },
    },
    manifest: {
      schema: 1,
      name: 'Card',
      inputs: {
        type: 'object',
        properties: { bal: { type: 'number' }, since: { type: 'string' } },
      },
      sample: { bal: 25, since: '2026-01-01T00:00:00Z' },
      bindings: [
        { to: { field: 'bal' }, value: '{{bal}}' },
        { to: { field: 'since' }, value: '{{since}}' },
      ],
      display: { title: 'Card' },
    },
  } as DesignDoc;
}

const display: ScanDisplayDoc = {
  v: 1,
  holder: '{{pass.title}}',
  header: {},
  panels: [
    {
      id: 'p',
      rows: [
        { id: 'r1', type: 'field', label: 'Balance', value: '{{fields.bal}}' },
        { id: 'r2', type: 'field', label: 'Since', value: '{{fields.since}}' },
      ],
    },
  ],
};

describe('designer preview formatting', () => {
  it('shows money with its currency and dates in the given zone, as the scanner does', () => {
    const scope = syntheticScope(doc(), 'door', NOW);
    const rendered = renderScanDisplay(display, scope, {
      screen: 'ok',
      role: 'door',
      locale: 'en',
      timeZone: 'America/Los_Angeles',
      now: NOW,
    });
    const rows = rendered.panels.flatMap((panel) => panel.rows);
    const text = rows.map((row) => ('value' in row ? row.value : null));
    expect(text).toEqual(['$25.00', 'Dec 31, 2025']);
  });
});
