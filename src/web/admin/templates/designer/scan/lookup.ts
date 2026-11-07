import { DEFAULT_SCAN_ACTION } from '../../../../../shared/scan-defaults.ts';
import { type DesignDoc, type Dict, isRecord } from '../model.ts';
import { copy } from '../ops-pass.ts';

export function lookupInput(manifest: Dict): string {
  const scan = isRecord(manifest.scan) ? manifest.scan : {};
  return isRecord(scan.lookup) && typeof scan.lookup.input === 'string' ? scan.lookup.input : '';
}

export function lookupInputs(manifest: Dict): { value: string; label: string }[] {
  const props =
    isRecord(manifest.inputs) && isRecord(manifest.inputs.properties)
      ? manifest.inputs.properties
      : {};
  return Object.entries(props).flatMap(([name, schema]) =>
    isRecord(schema) && (schema.type === 'string' || schema.type === 'integer')
      ? [{ value: name, label: typeof schema['x-label'] === 'string' ? schema['x-label'] : name }]
      : [],
  );
}

export function setLookupInput(doc: DesignDoc, input: string): DesignDoc {
  if (input && !lookupInputs(doc.manifest).some((s) => s.value === input)) return doc;
  const next = copy(doc);
  const scan = isRecord(next.manifest.scan) ? next.manifest.scan : {};
  if (input) next.manifest.scan = { actions: [DEFAULT_SCAN_ACTION], ...scan, lookup: { input } };
  else if (scan.lookup !== undefined) {
    delete scan.lookup;
    next.manifest.scan = scan;
  }
  return next;
}

/** Renaming or changing the identifier input must not leave a broken scan setting. */
export function reconcileLookup(doc: DesignDoc, from: string, to = from): DesignDoc {
  return lookupInput(doc.manifest) === from
    ? setLookupInput(doc, lookupInputs(doc.manifest).some((s) => s.value === to) ? to : '')
    : doc;
}
