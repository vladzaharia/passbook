import type { ScanAction } from '@/passkit/types.ts';
import { COUNTER_COPY } from '@/shared/copy/counters.ts';
import { type DesignDoc, type Dict, isRecord } from './model.ts';
import { readActions } from './scan/actions/model.ts';
import { countInputs } from './stamps.ts';

export const COUNTER_MAX = 4;
export const SIZE_MIN = 1;
export const SIZE_MAX = 1000;
const ID = /^[a-z][a-z0-9_]{0,31}$/;

export interface CounterView {
  id: string;
  input: string;
  /** A fixed size; per-pass sizes (`{ input }`) are shown, not edited here. */
  size: number | { input: string };
  label: string;
  tilt: boolean;
  art: boolean;
}

export type CounterOp =
  | { op: 'counter-add'; label: string }
  | {
      op: 'counter-set';
      id: string;
      patch: { label?: string; size?: number; input?: string; tilt?: boolean };
    }
  | { op: 'counter-remove'; id: string }
  | { op: 'counter-scan'; id: string; kind: 'use' | 'refill'; on: boolean };

const STYLES = ['generic', 'posterGeneric', 'storeCard', 'coupon', 'eventTicket', 'boardingPass'];
const MADE_HELP = 'What is left. A new pass starts full.';
const textOf = (id: string) => `{{pass.counters.${id}.text}}`;
const counterMap = (doc: Pick<DesignDoc, 'manifest'>): Dict =>
  isRecord(doc.manifest.counters) ? doc.manifest.counters : {};

function fieldLists(passJson: Dict): Dict[][] {
  return STYLES.flatMap((s) => {
    const dict = passJson[s];
    return isRecord(dict)
      ? Object.values(dict).flatMap((v) => (Array.isArray(v) ? [v.filter(isRecord) as Dict[]] : []))
      : [];
  });
}

/** The field a binding sets to "{n} left", if any. */
function labelField(doc: DesignDoc, id: string): string | undefined {
  const bindings = Array.isArray(doc.manifest.bindings) ? doc.manifest.bindings : [];
  const hit = bindings.find(
    (b) => isRecord(b) && b.value === textOf(id) && isRecord(b.to) && !b.to.prop && !b.when,
  );
  return isRecord(hit) && isRecord(hit.to) && typeof hit.to.field === 'string'
    ? hit.to.field
    : undefined;
}

export function readCounters(doc: DesignDoc): CounterView[] {
  return Object.entries(counterMap(doc)).flatMap(([id, c]) => {
    if (!isRecord(c) || typeof c.input !== 'string') return [];
    const key = labelField(doc, id);
    const field = fieldLists(doc.passJson)
      .flat()
      .find((f) => f.key === key);
    const input = (isRecord(doc.manifest.inputs) ? doc.manifest.inputs.properties : undefined) as
      | Dict
      | undefined;
    const node = input?.[c.input];
    const label =
      typeof field?.label === 'string' && field.label
        ? field.label
        : isRecord(node) && typeof node['x-label'] === 'string'
          ? node['x-label']
          : id;
    return [
      {
        id,
        input: c.input,
        size: isRecord(c.size) ? { input: String(c.size.input) } : Number(c.size),
        label,
        tilt: c.tilt !== false,
        art: isRecord(c.art),
      },
    ];
  });
}

/** What a full counter reads on the pass: "10 left". */
export const leftText = (n: number) => COUNTER_COPY.left.replace('{n}', String(n));

export function slugOf(label: string, taken: readonly string[]): string {
  let base = label
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 28);
  if (!/^[a-z]/.test(base)) base = `c_${base}`.replace(/_$/, '');
  if (!ID.test(base)) base = 'count';
  let id = base;
  for (let n = 2; taken.includes(id); n++) id = `${base}_${n}`;
  return id;
}

const properties = (manifest: Dict): Dict => {
  const inputs = isRecord(manifest.inputs) ? manifest.inputs : { type: 'object' };
  manifest.inputs = {
    ...inputs,
    properties: isRecord(inputs.properties) ? { ...inputs.properties } : {},
  };
  return (manifest.inputs as Dict).properties as Dict;
};

function addCounter(doc: DesignDoc, label: string): DesignDoc {
  const name = label.trim();
  const counters = counterMap(doc);
  if (!name || Object.keys(counters).length >= COUNTER_MAX) return doc;
  const manifest = structuredClone(doc.manifest) as Dict;
  const passJson = structuredClone(doc.passJson) as Dict;
  const props = properties(manifest);
  const id = slugOf(name, [...Object.keys(counters), ...Object.keys(props)]);
  const size = 10;
  props[id] = {
    type: 'integer',
    minimum: 0,
    default: size,
    'x-label': name,
    'x-order': 45,
    'x-help': MADE_HELP,
  };
  manifest.sample = { ...(isRecord(manifest.sample) ? manifest.sample : {}), [id]: size };
  manifest.counters = { ...counters, [id]: { input: id, size } };
  const taken = fieldLists(passJson).flatMap((l) => l.map((f) => f.key));
  let key = id;
  for (let n = 2; taken.includes(key); n++) key = `${id}_${n}`;
  const style = STYLES.find((s) => isRecord(passJson[s]));
  if (style) {
    const dict = passJson[style] as Dict;
    // Not the header: a third header field squeezes the logo text.
    dict.secondaryFields = [
      ...(Array.isArray(dict.secondaryFields) ? dict.secondaryFields : []),
      { key, label: name, value: '' },
    ];
  }
  const bindings = Array.isArray(manifest.bindings) ? manifest.bindings : [];
  manifest.bindings = [{ to: { field: key }, value: textOf(id) }, ...bindings];
  return { ...doc, passJson, manifest };
}

function actionOf(doc: DesignDoc, c: CounterView, kind: 'use' | 'refill'): ScanAction | undefined {
  return readActions(doc).find((a) =>
    kind === 'use'
      ? a.kind === 'take' && a.input === c.input && a.amount === 1
      : a.kind === 'set' && a.input === c.input && typeof a.value === 'number',
  );
}
export const hasScan = (doc: DesignDoc, c: CounterView, kind: 'use' | 'refill') =>
  actionOf(doc, c, kind) !== undefined;

function putActions(doc: DesignDoc, actions: ScanAction[]): DesignDoc {
  const scan = isRecord(doc.manifest.scan) ? doc.manifest.scan : {};
  return { ...doc, manifest: { ...doc.manifest, scan: { ...scan, actions } } };
}

function setScan(doc: DesignDoc, c: CounterView, kind: 'use' | 'refill', on: boolean): DesignDoc {
  const actions = readActions(doc);
  const old = actionOf(doc, c, kind);
  if (!on)
    return old
      ? putActions(
          doc,
          actions.filter((a) => a !== old),
        )
      : doc;
  if (old || actions.length >= 6 || typeof c.size !== 'number') return old ? doc : doc;
  const stem = c.id;
  const taken = actions.map((a) => a.id);
  const label = kind === 'use' ? 'Use one' : 'Refill';
  const id = [`${stem}_${kind}`, ...Array.from({ length: 8 }, (_, i) => `${stem}_${kind}${i + 2}`)]
    .map((x) => x.slice(0, 32))
    .find((x) => !taken.includes(x));
  const labels = actions.map((a) => a.label);
  const made: ScanAction =
    kind === 'use'
      ? {
          id: id ?? `${stem}_use`,
          label: labels.includes(label) ? `${label} ${c.label}`.slice(0, 24) : label,
          kind: 'take',
          input: c.input,
          amount: 1,
        }
      : {
          id: id ?? `${stem}_refill`,
          label: labels.includes(label) ? `Refill ${c.label}`.slice(0, 24) : label,
          kind: 'set',
          input: c.input,
          value: c.size,
          minRole: 'manager',
        };
  return putActions(doc, [...actions, made]);
}

function setCounter(
  doc: DesignDoc,
  id: string,
  patch: Extract<CounterOp, { op: 'counter-set' }>['patch'],
): DesignDoc {
  const view = readCounters(doc).find((c) => c.id === id);
  if (!view) return doc;
  const manifest = structuredClone(doc.manifest) as Dict;
  const passJson = structuredClone(doc.passJson) as Dict;
  const block = { ...(counterMap(doc)[id] as Dict) };
  const props = properties(manifest);
  const node = isRecord(props[view.input]) ? (props[view.input] as Dict) : undefined;
  let out: DesignDoc = { ...doc, manifest, passJson };
  if (patch.size !== undefined && typeof view.size === 'number') {
    const min = view.art ? 3 : SIZE_MIN;
    const max = view.art ? 20 : SIZE_MAX;
    const size = Math.max(min, Math.min(max, Math.round(patch.size)));
    block.size = size;
    // A new pass starts full, and a refill sets it back to the full size.
    if (node && node.default === view.size) node.default = size;
    const sample = isRecord(manifest.sample) ? manifest.sample : {};
    if (sample[view.input] === view.size) manifest.sample = { ...sample, [view.input]: size };
    out = {
      ...out,
      manifest: {
        ...manifest,
        scan:
          isRecord(manifest.scan) && Array.isArray(manifest.scan.actions)
            ? {
                ...manifest.scan,
                actions: manifest.scan.actions.map((a: unknown) =>
                  isRecord(a) && a.kind === 'set' && a.input === view.input && a.value === view.size
                    ? { ...a, value: size }
                    : a,
                ),
              }
            : manifest.scan,
      },
    };
  }
  if (patch.tilt !== undefined) {
    if (patch.tilt) delete block.tilt;
    else block.tilt = false;
  }
  if (
    patch.input !== undefined &&
    patch.input !== view.input &&
    countInputs(manifest).some((i) => i.value === patch.input)
  ) {
    block.input = patch.input;
    const next = props[patch.input];
    if (isRecord(next)) next.minimum = 0;
  }
  if (patch.label !== undefined) {
    const key = labelField(doc, id);
    for (const list of fieldLists(out.passJson))
      for (const f of list) if (f.key === key) f.label = patch.label;
    if (node) node['x-label'] = patch.label;
  }
  out.manifest.counters = { ...counterMap(doc), [id]: block };
  return out;
}

function removeCounter(doc: DesignDoc, id: string): DesignDoc {
  const view = readCounters(doc).find((c) => c.id === id);
  if (!view) return doc;
  const manifest = structuredClone(doc.manifest) as Dict;
  const passJson = structuredClone(doc.passJson) as Dict;
  const key = labelField(doc, id);
  const rest = { ...counterMap(doc) };
  delete rest[id];
  if (Object.keys(rest).length) manifest.counters = rest;
  else delete manifest.counters;
  const bindings = Array.isArray(manifest.bindings) ? manifest.bindings : [];
  manifest.bindings = bindings.filter(
    (b) =>
      !(isRecord(b) && typeof b.value === 'string' && b.value.includes(`pass.counters.${id}.`)),
  );
  for (const s of STYLES) {
    const dict = passJson[s];
    if (isRecord(dict))
      for (const [group, list] of Object.entries(dict))
        if (Array.isArray(list))
          dict[group] = list.filter((f) => !(isRecord(f) && key !== undefined && f.key === key));
  }
  // An input this section made goes too; one it found stays.
  const props = properties(manifest);
  const node = props[view.input];
  const shared = Object.values(rest).some((c) => isRecord(c) && c.input === view.input);
  if (isRecord(node) && node['x-help'] === MADE_HELP && !shared) {
    delete props[view.input];
    const sample = isRecord(manifest.sample) ? { ...manifest.sample } : {};
    delete sample[view.input];
    manifest.sample = sample;
  }
  let out: DesignDoc = { ...doc, passJson, manifest };
  // Its scanner actions go with it.
  for (const kind of ['use', 'refill'] as const) {
    const action = actionOf(doc, view, kind);
    if (action) out = dropAction(out, action.id);
  }
  return out;
}

function dropAction(doc: DesignDoc, id: string): DesignDoc {
  const left = readActions(doc).filter((a) => a.id !== id);
  const scan = isRecord(doc.manifest.scan) ? { ...doc.manifest.scan } : {};
  const manifest = { ...doc.manifest } as Dict;
  if (left.length === 0 && Object.keys(scan).every((k) => k === 'actions')) delete manifest.scan;
  else manifest.scan = { ...scan, actions: left };
  return { ...doc, manifest };
}

export function applyCounterOp(doc: DesignDoc, o: CounterOp): DesignDoc {
  switch (o.op) {
    case 'counter-add':
      return addCounter(doc, o.label);
    case 'counter-set':
      return setCounter(doc, o.id, o.patch);
    case 'counter-remove':
      return removeCounter(doc, o.id);
    case 'counter-scan': {
      const view = readCounters(doc).find((c) => c.id === o.id);
      return view ? setScan(doc, view, o.kind, o.on) : doc;
    }
  }
}
