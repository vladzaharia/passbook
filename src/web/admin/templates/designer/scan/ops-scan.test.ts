import { describe, expect, it } from 'vitest';
import { scanIssues as manifestScanIssues } from '@/passkit/template/scan.ts';
import type { ScanDisplayDoc } from '@/passkit/template/scan-display/schema.ts';
import type { TemplateManifest } from '@/passkit/types.ts';
import { DEFAULT_SCAN_ACTION } from '@/shared/scan-defaults.ts';
import { sampleDoc } from '../fixtures.ts';
import { applyScanOp } from './ops-scan.ts';

describe('scan display operation', () => {
  it('writes only the display and preserves other scan settings without mutating the source', () => {
    const base = sampleDoc();
    base.manifest.scan = { lookup: 'member', actions: [{ id: 'check_in', kind: 'check_in' }] };
    const before = structuredClone(base);
    const display: ScanDisplayDoc = { v: 1, header: { title: 'Welcome' } };
    const result = applyScanOp(base, { op: 'scan-display', display });
    expect(base).toEqual(before);
    expect(result.manifest.scan).toEqual({ ...(before.manifest.scan as object), display });
    expect(result.passJson).toBe(base.passJson);
    expect(result.assets).toBe(base.assets);
    expect(applyScanOp(result, { op: 'scan-display', display })).toBe(result);
  });

  it('materializes the implicit action when adding the first scan block', () => {
    const base = sampleDoc();
    const display: ScanDisplayDoc = { v: 1, header: {} };
    const result = applyScanOp(base, { op: 'scan-display', display });
    expect(result.manifest.scan).toEqual({ actions: [DEFAULT_SCAN_ACTION], display });
    expect(base.manifest.scan).toBeUndefined();
    expect(manifestScanIssues(result.manifest as unknown as TemplateManifest)).toEqual([]);
  });

  it('replays the same operation deterministically', () => {
    const doc = sampleDoc();
    const op = {
      op: 'scan-display' as const,
      display: {
        v: 1 as const,
        header: {},
        panels: [{ id: 'p1', rows: [{ id: 'r1', type: 'note' as const, text: 'Remember' }] }],
      },
    };
    expect(applyScanOp(doc, op)).toEqual(applyScanOp(doc, op));
  });
});
