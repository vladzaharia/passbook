import { describe, expect, it } from 'vitest';
import { renderScanDisplay } from '@/passkit/template/scan-display/render.ts';
import type { ScanDisplayDoc } from '@/passkit/template/scan-display/schema.ts';
import { sampleDoc } from '../fixtures.ts';
import type { DesignDoc } from '../model.ts';
import { scanDisplayOf, scanIssues } from './document.ts';

const display: ScanDisplayDoc = {
  v: 1,
  header: { title: 'Welcome' },
  panels: [
    {
      id: 'p_access',
      title: 'Access',
      rows: [{ id: 'r_seat', type: 'field', label: 'Seat', value: '{{inputs.seat}}' }],
    },
  ],
};

function withDisplay(doc: DesignDoc, value: ScanDisplayDoc): DesignDoc {
  return { ...doc, manifest: { ...doc.manifest, scan: { display: value } } };
}

describe('scan designer document', () => {
  it('round trips an authored display into the real renderer without changing the original', () => {
    const base = sampleDoc();
    const authored = withDisplay(base, display);
    expect(scanDisplayOf(base)).toBeNull();
    expect(scanDisplayOf(authored)).toEqual(display);
    const rendered = renderScanDisplay(
      scanDisplayOf(authored)!,
      { inputs: { seat: '12' } },
      {
        screen: 'ok',
        role: 'door',
        locale: 'en',
        timeZone: 'UTC',
        now: 0,
      },
    );
    expect(rendered.panels[0]?.rows[0]).toMatchObject({ type: 'field', value: '12' });
  });

  it('reports unsafe and invalid displays locally without throwing away the draft', () => {
    const base = sampleDoc();
    const unsafe = withDisplay(base, { ...display, header: { title: '{{pass.email}}' } });
    expect(scanIssues(unsafe).some((issue) => issue.code === 'SCAN_DISPLAY_SECRET')).toBe(true);
    const malformed = withDisplay(base, { ...display, panels: [{ id: 'bad id', rows: [] }] });
    expect(scanDisplayOf(malformed)).not.toBeNull();
    expect(scanIssues(malformed).some((issue) => issue.severity === 'error')).toBe(true);
    const corrupt = { ...base, manifest: { ...base.manifest, scan: { display: 'invalid' } } };
    expect(scanDisplayOf(corrupt)).toBeNull();
    expect(scanIssues(corrupt).some((issue) => issue.severity === 'error')).toBe(true);
    expect(corrupt.manifest.scan.display).toBe('invalid');
  });

  it('blocks contact-like literal text and clears the error after correction', () => {
    const base = sampleDoc();
    const privateNote = withDisplay(base, {
      v: 1,
      header: {},
      notes: { refused: 'Contact person@example.test' },
    });
    expect(scanIssues(privateNote)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          severity: 'error',
          code: 'SCAN_DISPLAY_PRIVATE_TEXT',
          path: 'scan.display.notes.refused',
        }),
      ]),
    );
    const fixed = withDisplay(base, {
      v: 1,
      header: {},
      notes: { refused: 'Please see the desk.' },
    });
    expect(scanIssues(fixed).some((issue) => issue.code === 'SCAN_DISPLAY_PRIVATE_TEXT')).toBe(
      false,
    );
  });

  it('validates using field metadata without inspecting barcode or Wallet values', () => {
    const doc = withDisplay(sampleDoc(), { v: 1, header: {} });
    Object.defineProperty(doc.passJson, 'barcodes', {
      get: () => {
        throw new Error('barcode read');
      },
    });
    const generic = doc.passJson.generic as { primaryFields: Record<string, unknown>[] };
    Object.defineProperty(generic.primaryFields[0]!, 'value', {
      get: () => {
        throw new Error('field value read');
      },
    });
    expect(() => scanIssues(doc)).not.toThrow();
  });

  it('blocks an over-budget panel before a server dry run', () => {
    const doc = withDisplay(sampleDoc(), {
      v: 1,
      header: {},
      panels: [
        {
          id: 'p_full',
          rows: Array.from({ length: 6 }, (_, n) => ({
            id: `r_${n}`,
            type: 'note' as const,
            text: 'Note',
          })),
        },
      ],
    });
    expect(scanIssues(doc)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ severity: 'error', code: 'SCAN_DISPLAY_DENSITY' }),
      ]),
    );
  });
});
