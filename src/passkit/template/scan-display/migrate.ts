import type { ScanDisplayDoc } from './schema.ts';

/** A stored doc to the latest schema, at read. `v: 1` is the latest, so this is the identity. */
export function migrateScanDisplay(doc: ScanDisplayDoc): ScanDisplayDoc {
  const version = (doc as { v: number }).v;
  if (version !== 1) throw new Error(`scan-display:migrate: unknown version ${version}`);
  return doc;
}
