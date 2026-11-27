import type { ScanDisplayDoc } from '@/passkit/template/scan-display/schema.ts';
import { type DesignDoc, isRecord } from '../model.ts';

/** Keep in-progress text even when it temporarily fails schema validation. */
export function scanDisplayOf(doc: DesignDoc): ScanDisplayDoc | null {
  const scan = isRecord(doc.manifest.scan) ? doc.manifest.scan : null;
  const display = scan?.display;
  if (!isRecord(display) || display.v !== 1 || !isRecord(display.header)) return null;
  return display as unknown as ScanDisplayDoc;
}
