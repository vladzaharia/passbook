import { describe, expect, it } from 'vitest';
import { density } from '@/passkit/template/scan-display/density.ts';
import { filterDoc, renderScanDisplay } from '@/passkit/template/scan-display/render.ts';
import type { ScanDisplayDoc } from '@/passkit/template/scan-display/schema.ts';
import type { ScanRole } from '@/passkit/types.ts';
import type { ScanDisplayScreen } from '@/shared/contracts/scan-display.ts';
import { type DesignDoc, isRecord } from '../model.ts';
import {
  cutRows,
  displayForPreview,
  hasUnsafeRenderedText,
  previewFit,
  previewPassFields,
  safeRealScope,
  scopeForOutcome,
  syntheticScope,
} from './scan-preview.ts';
import { safePreviewText } from './scan-preview-policy.ts';

const NOW = Date.UTC(2026, 10, 5, 18);
const options = (screen: ScanDisplayScreen, role: ScanRole) => ({
  screen,
  role,
  now: NOW,
  locale: 'en',
  timeZone: 'UTC',
});

function fixture(): DesignDoc {
  return {
    assets: [],
    passJson: {
      generic: {
        primaryFields: [{ key: 'seat', label: 'Seat' }],
        secondaryFields: [{ key: 'copied', label: 'Copy' }],
        additionalInfoFields: [{ key: 'info', label: 'Info' }],
        footerFields: [{ key: 'footer', label: 'Footer' }],
      },
    },
    manifest: {
      schema: 1,
      name: 'Concert',
      inputs: {
        type: 'object',
        properties: {
          memberName: { type: 'string' },
          seat: { type: 'string' },
          tier: { type: 'string', 'x-scan': 'desk' },
          lounge: { type: 'string', 'x-scan': 'manager' },
          contactEmail: { type: 'string', 'x-scan': 'door' },
          phone: { type: 'string', 'x-scan': 'door' },
          code: { type: 'string' },
          altCode: { type: 'string' },
          profile: {
            type: 'object',
            properties: {
              publicLabel: { type: 'string' },
              managerHint: { type: 'string', 'x-scan': 'manager' },
            },
          },
        },
      },
      sample: {
        memberName: 'Alex',
        seat: 'A12',
        tier: 'Gold',
        lounge: 'Private lounge',
        contactEmail: 'person@example.test',
        phone: '+1 212 555 0199',
        code: 'shared-code-secret',
        altCode: 'barcode-alt-secret',
        profile: { publicLabel: 'Balcony', managerHint: 'Manager hint' },
      },
      bindings: [
        { to: { field: 'seat' }, value: '{{seat}}' },
        { to: { barcode: 0, prop: 'message' }, value: '{{code}}' },
        { to: { barcode: 0, prop: 'altText' }, value: '{{altCode}}' },
        { to: { field: 'copied' }, value: '{{code}}' },
        { to: { field: 'lounge' }, value: '{{lounge}}' },
      ],
      display: { title: '{{memberName}}', subtitle: '{{lounge}}' },
      lookups: { directory: { visible: { label: 'Balcony' }, hidden: { label: 'Manager hint' } } },
      scan: { actions: [{ id: 'check_in', label: 'Check in', kind: 'check_in' }] },
    },
  };
}

const display: ScanDisplayDoc = {
  v: 1,
  holder: '{{inputs.memberName}}',
  header: { subtitle: '{{inputs.tier}}' },
  panels: [
    {
      id: 'p_ticket',
      title: 'Ticket',
      rows: [
        { id: 'r_seat', type: 'field', label: 'Seat', value: '{{inputs.seat}}' },
        {
          id: 'r_lounge',
          type: 'field',
          label: 'Lounge',
          value: '{{inputs.lounge}}',
          minRole: 'manager',
        },
      ],
    },
  ],
  notes: { refused: 'Please see the desk.' },
};

describe('scan designer preview safety', () => {
  it('filters samples, defaults, nested values, copies and all barcode inputs for every role', () => {
    const doc = fixture();
    const before = structuredClone(doc);
    for (const role of ['door', 'desk', 'manager'] as const) {
      const scope = syntheticScope(doc, role, NOW);
      const text = JSON.stringify(scope);
      expect(text).not.toContain('person@example.test');
      expect(text).not.toContain('212 555 0199');
      expect(text).not.toContain('shared-code-secret');
      expect(text).not.toContain('barcode-alt-secret');
      expect(text).toContain('Balcony');
      expect(text.includes('Gold')).toBe(role !== 'door');
      expect(text.includes('Private lounge')).toBe(role === 'manager');
      expect(text.includes('Manager hint')).toBe(role === 'manager');
      expect(scope.fields).not.toHaveProperty('copied');
    }
    expect(doc).toEqual(before);
  });

  it('reapplies draft role policy to a real scope, including derived fields and pass projection', () => {
    const doc = fixture();
    const real = {
      inputs: {
        memberName: 'Alex',
        seat: 'A12',
        tier: 'Gold',
        lounge: 'Private lounge',
        profile: { publicLabel: 'Balcony', managerHint: 'Manager hint' },
      },
      fields: { seat: 'A12', lounge: 'Private lounge' },
      pass: { title: 'Alex', subtitle: 'Private lounge' },
      lookups: { d: { one: { label: 'Manager hint' } } },
    };
    const door = safeRealScope(doc, 'door', real);
    expect(JSON.stringify(door)).not.toContain('Gold');
    expect(JSON.stringify(door)).not.toContain('Private lounge');
    expect(JSON.stringify(door)).not.toContain('Manager hint');
    expect(door.fields).toEqual({});
    expect(door.pass).toEqual({ title: 'Alex', templateName: 'Concert' });
    const manager = safeRealScope(doc, 'manager', real);
    expect(JSON.stringify(manager)).toContain('Private lounge');
    expect(real.inputs.lounge).toBe('Private lounge');
  });

  it('never dereferences hidden synthetic, override, real input or real field values', () => {
    const doc = fixture();
    const sample = doc.manifest.sample;
    if (!isRecord(sample) || !isRecord(sample.profile)) throw new Error('bad test fixture');
    const forbidden = () => {
      throw new Error('protected value was read');
    };
    for (const key of ['contactEmail', 'phone', 'code', 'altCode', 'tier'])
      Object.defineProperty(sample, key, { enumerable: true, get: forbidden });
    Object.defineProperty(sample.profile, 'managerHint', { enumerable: true, get: forbidden });
    const schemas = doc.manifest.inputs;
    const lookups = doc.manifest.lookups;
    if (
      !isRecord(schemas) ||
      !isRecord(schemas.properties) ||
      !isRecord(schemas.properties.tier) ||
      !isRecord(lookups)
    )
      throw new Error('bad test fixture');
    Object.defineProperty(schemas.properties.tier, 'default', { enumerable: true, get: forbidden });
    Object.defineProperty(lookups, 'hiddenCopy', { enumerable: true, get: forbidden });
    const overrides: Record<string, string> = {};
    Object.defineProperty(overrides, 'lounge', { enumerable: true, get: forbidden });
    const synthetic = syntheticScope(doc, 'door', NOW, overrides);
    expect(synthetic.inputs).toMatchObject({
      memberName: 'Alex',
      seat: 'A12',
      profile: { publicLabel: 'Balcony' },
    });
    expect(synthetic.lookups).toEqual({});

    const inputs = { memberName: 'Alex', seat: 'A12' };
    const fields = { seat: 'A12' };
    Object.defineProperty(inputs, 'lounge', { enumerable: true, get: forbidden });
    Object.defineProperty(fields, 'lounge', { enumerable: true, get: forbidden });
    const real = { inputs, fields, pass: { title: 'Alex' } };
    Object.defineProperty(real, 'lookups', { enumerable: true, get: forbidden });
    const safe = safeRealScope(doc, 'door', real);
    expect(safe.inputs).toMatchObject({ memberName: 'Alex', seat: 'A12' });
    expect(safe.fields).toEqual({});
    expect(safe.lookups).toEqual({});
  });

  it('projects every field group without reading pass field values or barcode contents', () => {
    const doc = fixture();
    Object.defineProperty(doc.passJson, 'barcodes', {
      get: () => {
        throw new Error('barcode read');
      },
    });
    const block = doc.passJson.generic;
    if (
      !isRecord(block) ||
      !Array.isArray(block.primaryFields) ||
      !isRecord(block.primaryFields[0])
    )
      throw new Error('bad test fixture');
    Object.defineProperty(block.primaryFields[0], 'value', {
      get: () => {
        throw new Error('value read');
      },
    });
    const pass = previewPassFields(doc);
    expect(pass).toMatchObject({
      generic: { additionalInfoFields: [{ key: 'info' }], footerFields: [{ key: 'footer' }] },
    });
    expect(() => displayForPreview(doc, null)).not.toThrow();
  });

  it.each(['ready', 'ok', 'heads_up', 'refused'] as const)(
    'uses the real renderer for %s and preserves role visibility',
    (screen) => {
      const doc = fixture();
      for (const role of ['door', 'desk', 'manager'] as const) {
        const scope = syntheticScope(doc, role, NOW);
        const out = renderScanDisplay(display, scope, options(screen, role));
        expect(out.screen).toBe(screen);
        expect(out.identity.holder).toBe('Alex');
        expect(out.panels.flatMap((p) => p.rows).some((r) => r.id === 'r_lounge')).toBe(
          screen !== 'refused' && role === 'manager',
        );
        if (screen === 'refused') {
          expect(out.panels).toEqual([]);
          expect(out.header.chips).toEqual([]);
          expect(out.notes.refused).toBe('Please see the desk.');
        }
      }
    },
  );

  it('uses the shared density budget and distinguishes renderer cuts from hidden conditions', () => {
    const crowded: ScanDisplayDoc = {
      v: 1,
      header: {},
      panels: [
        {
          id: 'p',
          rows: [
            { id: 'a', type: 'field', label: 'A', value: 'One' },
            { id: 'b', type: 'field', label: 'B', value: 'Two' },
            { id: 'c', type: 'field', label: 'C', value: 'Three' },
            { id: 'd', type: 'field', label: 'D', value: 'Four' },
            { id: 'e', type: 'field', label: 'E', value: 'Five' },
            {
              id: 'f',
              type: 'field',
              label: 'F',
              value: 'Six',
              when: { path: 'inputs.seat', eq: 'Z99' },
            },
          ],
        },
      ],
    };
    const scope = syntheticScope(fixture(), 'door', NOW);
    const opts = options('heads_up', 'door');
    const rendered = renderScanDisplay(crowded, scope, opts);
    const cuts = cutRows(crowded, scope, opts, rendered);
    expect(cuts.size).toBeGreaterThan(0);
    expect(cuts.has('f')).toBe(false);
    const fit = previewFit(filterDoc(crowded, 'door'), 'heads_up');
    expect(fit.units).toBe(density(crowded, 'heads_up'));
    expect(fit.capacity).toBe(6);
    expect(fit.panels[0]?.units).toBe(6);
    const named: ScanDisplayDoc = {
      v: 1,
      header: { title: 'Welcome {{holder.firstName}}' },
      photo: {},
      notes: { staff: 'See the desk.' },
    };
    const namedFit = previewFit(named, 'ok');
    expect(namedFit.headerParts).toEqual([
      { label: 'Staff note', units: 1 },
      { label: 'Title', units: 3 },
      { label: 'Photo', units: 1 },
    ]);
    expect(namedFit.headerParts.reduce((sum, part) => sum + part.units, 0)).toBe(namedFit.header);
  });

  it('simulates the chosen action and rejects contact and raw-JSON text after rendering', () => {
    const scope = scopeForOutcome(
      { inputs: { stamps: 9 } },
      'ok',
      { id: 'add', label: 'Add', kind: 'add', input: 'stamps', amount: 2 },
      NOW,
    );
    expect(scope.scan).toMatchObject({
      outcome: 'ok',
      action: { id: 'add' },
      before: 7,
      after: 9,
      amount: 2,
    });
    expect(hasUnsafeRenderedText({ title: 'person@example.test' })).toBe(true);
    expect(hasUnsafeRenderedText({ value: '{"private":true}' })).toBe(true);
    expect(
      hasUnsafeRenderedText({
        id: '01970237-aaaa-bbbb-cccc-123456789abc',
        url: 'https://assets.example/photo.png',
      }),
    ).toBe(false);
  });
});

describe('safePreviewText', () => {
  it('allows dates, times, ranges and short codes', () => {
    for (const text of [
      'Valid until 2026-11-30',
      '2026-11-30T18:30',
      'Doors 18.00 - 23.00',
      'Season 2025-2026',
      'Open 30.11.2026',
      'VIP2',
      'Order 12345',
    ])
      expect(safePreviewText(text), text).toBe(true);
  });

  it('still refuses phone numbers, contact details and templates', () => {
    for (const text of [
      '+1 (212) 555-0100',
      '212-555-0100',
      '01.23.45.67.89',
      '2026-11-30 call 212 555 0100',
      'ada@example.com',
      'https://example.com',
      '{{inputs.email}}',
    ])
      expect(safePreviewText(text), text).toBe(false);
  });
});
