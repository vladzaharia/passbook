import {
  barcodeSource,
  bindBarcode,
  dropInputRefs,
  escapeRe,
  renameInputRefs,
  type Source,
} from './bindings.ts';
import { type InputSpec, nameProblem, readInputs, scalarInputs, writeInputs } from './inputs.ts';
import { type DesignDoc, type Dict, isRecord } from './model.ts';
import { copy } from './ops-pass.ts';

export interface BarcodeSettings {
  enabled: boolean;
  format: string;
  /** Static text, one input or the pass's scan code. */
  message: Source;
  /** Static text shown under the code; defaults to the message. */
  altText: Source;
  staticMessage: string;
  staticAlt: string;
}

export function readBarcode(doc: DesignDoc): BarcodeSettings {
  const first = Array.isArray(doc.passJson.barcodes) ? doc.passJson.barcodes[0] : undefined;
  const b: Dict = isRecord(first) ? first : {};
  return {
    enabled: isRecord(first),
    format: typeof b.format === 'string' ? b.format : 'PKBarcodeFormatQR',
    message: barcodeSource(doc.manifest, 'message'),
    altText: barcodeSource(doc.manifest, 'altText'),
    staticMessage: typeof b.message === 'string' ? b.message : '',
    staticAlt: typeof b.altText === 'string' ? b.altText : '',
  };
}

export function setBarcode(doc: DesignDoc, s: BarcodeSettings): DesignDoc {
  const next = copy(doc);
  if (!s.enabled) {
    delete next.passJson.barcodes;
    delete next.passJson.barcode;
    next.manifest.bindings = bindBarcode(
      { bindings: bindBarcode(next.manifest, 'message', { kind: 'static' }) },
      'altText',
      { kind: 'static' },
    );
    return next;
  }
  const rest = Array.isArray(next.passJson.barcodes) ? next.passJson.barcodes : [];
  const first: Dict = isRecord(rest[0]) ? rest[0] : {};
  const code: Dict = {
    ...first,
    format: s.format,
    message: s.staticMessage || 'SAMPLE',
    messageEncoding: first.messageEncoding ?? 'iso-8859-1',
  };
  if (s.staticAlt) code.altText = s.staticAlt;
  else delete code.altText;
  next.passJson.barcodes = [code, ...rest.slice(1)];
  const withMessage = bindBarcode(next.manifest, 'message', s.message);
  next.manifest.bindings = bindBarcode(
    { ...next.manifest, bindings: withMessage },
    'altText',
    s.altText,
  );
  return next;
}

export type ListKey = 'locations' | 'beacons' | 'relevantDates';

export function setList(doc: DesignDoc, key: ListKey, items: Dict[]): DesignDoc {
  const next = copy(doc);
  if (items.length) next.passJson[key] = items;
  else delete next.passJson[key];
  return next;
}

export const listOf = (doc: DesignDoc, key: ListKey): Dict[] =>
  Array.isArray(doc.passJson[key]) ? (doc.passJson[key] as unknown[]).filter(isRecord) : [];

export function setInputs(
  doc: DesignDoc,
  specs: InputSpec[],
  renamed?: { from: string; to: string },
): DesignDoc {
  const next = copy(doc);
  next.manifest = writeInputs(next.manifest, specs, renamed);
  return next;
}

export function addInput(doc: DesignDoc, spec: InputSpec): DesignDoc {
  return setInputs(doc, [...readInputs(doc.manifest), spec]);
}

export function updateInput(doc: DesignDoc, name: string, patch: Partial<InputSpec>): DesignDoc {
  const specs = readInputs(doc.manifest);
  const at = specs.findIndex((s) => s.name === name);
  const old = specs[at];
  if (!old) return doc;
  const merged = { ...old, ...patch };
  if (
    patch.name !== undefined &&
    patch.name !== name &&
    nameProblem(
      patch.name,
      specs.map((s) => s.name).filter((n) => n !== name),
    )
  )
    return doc;
  specs[at] = merged;
  let next = setInputs(
    doc,
    specs,
    merged.name !== name ? { from: name, to: merged.name } : undefined,
  );
  if (merged.name !== name)
    next = { ...next, manifest: renameInputRefs(next.manifest, name, merged.name) };
  return next;
}

export function removeInput(doc: DesignDoc, name: string): DesignDoc {
  const next = setInputs(
    doc,
    readInputs(doc.manifest).filter((s) => s.name !== name),
  );
  next.manifest.bindings = dropInputRefs(next.manifest, name);
  const display = isRecord(next.manifest.display) ? next.manifest.display : {};
  const search = Array.isArray(display.search) ? display.search.filter((s) => s !== name) : [];
  const keep = (v: unknown) =>
    typeof v === 'string' && new RegExp(`\\{\\{\\s*${escapeRe(name)}\\b`).test(v) ? undefined : v;
  next.manifest.display = {
    ...display,
    title: keep(display.title) ?? firstTitle(readInputs(next.manifest)),
    subtitle: keep(display.subtitle),
    search,
  };
  return next;
}

export function moveInput(doc: DesignDoc, name: string, to: number): DesignDoc {
  const specs = readInputs(doc.manifest);
  const at = specs.findIndex((s) => s.name === name);
  if (at < 0 || to < 0 || to >= specs.length || at === to) return doc;
  const [spec] = specs.splice(at, 1);
  specs.splice(to, 0, spec as InputSpec);
  return setInputs(doc, specs);
}

const firstTitle = (specs: InputSpec[]): string => {
  const first = scalarInputs(specs)[0];
  return first ? `{{${first.name}}}` : 'Pass';
};

/** The list row of a pass: title and subtitle read from inputs. */
export function setDisplay(doc: DesignDoc, part: 'title' | 'subtitle', expr: string): DesignDoc {
  const next = copy(doc);
  const display = isRecord(next.manifest.display) ? next.manifest.display : {};
  const merged: Dict = { ...display };
  if (expr === '') delete merged[part];
  else merged[part] = expr;
  if (merged.title === undefined) merged.title = firstTitle(readInputs(next.manifest));
  next.manifest.display = merged;
  return next;
}

export function setMeta(doc: DesignDoc, patch: { name?: string; description?: string }): DesignDoc {
  const next = copy(doc);
  if (patch.name !== undefined) next.manifest.name = patch.name;
  if (patch.description !== undefined) {
    if (patch.description === '') delete next.manifest.description;
    else next.manifest.description = patch.description;
  }
  return next;
}
