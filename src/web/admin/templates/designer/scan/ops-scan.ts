import type { ScanDisplayDoc } from '@/passkit/template/scan-display/schema.ts';
import { DEFAULT_SCAN_ACTION } from '@/shared/scan-defaults.ts';
import { type DesignDoc, isRecord } from '../model.ts';

/** Replaces the authored display; the designer owns its history. A new scan block also
 * materializes the otherwise implicit check-in action required by the manifest schema. */
export type ScanOp = { op: 'scan-display'; display: ScanDisplayDoc };

export function applyScanOp(doc: DesignDoc, op: ScanOp): DesignDoc {
  const scan = isRecord(doc.manifest.scan) ? doc.manifest.scan : {};
  if (scan.display === op.display) return doc;
  return {
    ...doc,
    manifest: {
      ...doc.manifest,
      scan: {
        ...(scan.actions === undefined ? { actions: [DEFAULT_SCAN_ACTION] } : {}),
        ...scan,
        display: op.display,
      },
    },
  };
}
