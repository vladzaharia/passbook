import { type Dict, isRecord } from './model.ts';

export const INPUT_TYPES = [
  { value: 'text', label: 'Text' },
  { value: 'textarea', label: 'Long text' },
  { value: 'number', label: 'Number' },
  { value: 'boolean', label: 'Yes or no' },
  { value: 'datetime', label: 'Date and time' },
  { value: 'email', label: 'Email' },
  { value: 'url', label: 'Link' },
] as const;
export type PickType = (typeof INPUT_TYPES)[number]['value'];
/** `list`: an array or object input (upcoming events, beacons). Its schema and sample are kept as is. */
export type InputType = PickType | 'list';

export const typeLabel = (type: InputType): string =>
  type === 'list' ? 'List' : (INPUT_TYPES.find((t) => t.value === type)?.label ?? type);

/** Inputs a scalar value (field, barcode, list title) can read. */
export const scalarInputs = (specs: readonly InputSpec[]): InputSpec[] =>
  specs.filter((s) => s.type !== 'list');

export interface InputSpec {
  name: string;
  label: string;
  type: InputType;
  required: boolean;
  /** Text as typed; parsed by type when written. */
  default: string;
  sample: string;
}

/** Names the expression engine refuses to read, plus `pass`, which is the server's scope. */
const RESERVED = new Set(['pass', '__proto__', 'constructor', 'prototype']);

export const NAME_PATTERN = /^[A-Za-z][A-Za-z0-9_]{0,39}$/;

/** Why a name cannot be used, or null. */
export function nameProblem(name: string, others: readonly string[]): string | null {
  if (!NAME_PATTERN.test(name)) return 'Start with a letter; use letters, digits and _ only.';
  if (RESERVED.has(name)) return `"${name}" is reserved. Pick another name.`;
  if (others.includes(name)) return 'Another input has this name.';
  return null;
}

function typeOf(schema: Dict): InputType {
  if (schema.type === 'array' || schema.type === 'object') return 'list';
  if (schema.type === 'number' || schema.type === 'integer') return 'number';
  if (schema.type === 'boolean') return 'boolean';
  if (schema.format === 'date-time') return 'datetime';
  if (schema.format === 'email') return 'email';
  if (schema.format === 'uri') return 'url';
  if (schema['x-widget'] === 'textarea') return 'textarea';
  return 'text';
}

const show = (v: unknown): string => (v === undefined || v === null ? '' : String(v));

const propsOf = (manifest: Dict): Dict =>
  isRecord(manifest.inputs) && isRecord(manifest.inputs.properties)
    ? manifest.inputs.properties
    : {};

export function readInputs(manifest: Dict): InputSpec[] {
  const required =
    isRecord(manifest.inputs) && Array.isArray(manifest.inputs.required)
      ? (manifest.inputs.required as string[])
      : [];
  const sample = isRecord(manifest.sample) ? manifest.sample : {};
  return Object.entries(propsOf(manifest))
    .map(([name, schema], i) => {
      const s = isRecord(schema) ? schema : {};
      const order = typeof s['x-order'] === 'number' ? s['x-order'] : i * 10;
      const type = typeOf(s);
      return {
        spec: {
          name,
          label: show(s['x-label']) || name,
          type,
          required: required.includes(name),
          default: type === 'list' ? '' : show(s.default),
          sample: type === 'list' ? '' : show(sample[name]),
        },
        order,
      };
    })
    .sort((a, b) => a.order - b.order)
    .map((x) => x.spec);
}

const parse = (type: InputType, text: string): unknown => {
  if (type === 'number') return Number.isFinite(Number(text)) ? Number(text) : undefined;
  if (type === 'boolean') return text === 'true';
  return text;
};

const orderOf = (node: Dict): number | undefined =>
  typeof node['x-order'] === 'number' ? node['x-order'] : undefined;

/** A fresh JSON Schema node for an input whose type is new or changed. */
export function schemaOf(spec: InputSpec, existing: Dict = {}, order = 10): Dict {
  const {
    format: _f,
    'x-widget': _w,
    maxLength: _m,
    minLength: _n,
    type: _t,
    default: _d,
    ...kept
  } = existing;
  const node: Dict = { ...kept, 'x-label': spec.label, 'x-order': order };
  if (spec.type === 'number') node.type = 'number';
  else if (spec.type === 'boolean') node.type = 'boolean';
  else {
    node.type = 'string';
    if (spec.type === 'textarea') Object.assign(node, { 'x-widget': 'textarea', maxLength: 1000 });
    else if (spec.type === 'datetime')
      Object.assign(node, { format: 'date-time', 'x-widget': 'datetime' });
    else if (spec.type === 'email')
      Object.assign(node, { format: 'email', 'x-widget': 'email', maxLength: 254 });
    else if (spec.type === 'url')
      Object.assign(node, { format: 'uri', 'x-widget': 'url', maxLength: 300 });
    else node.maxLength = 200;
    if (spec.required) node.minLength = 1;
  }
  const dflt = spec.default === '' ? undefined : parse(spec.type, spec.default);
  if (dflt !== undefined) node.default = dflt;
  return node;
}

/**
 * The node after an edit. A node whose type did not change keeps every keyword it has
 * (integer, date formats, widgets, limits); only the properties the user edited are touched.
 */
function nodeFor(spec: InputSpec, existing: Dict, wasRequired: boolean): Dict {
  const before = readInputs({ inputs: { properties: { [spec.name]: existing } } })[0];
  if (!before || before.type !== spec.type) return schemaOf(spec, existing, orderOf(existing));
  const node: Dict = { ...existing };
  if (before.label !== spec.label) node['x-label'] = spec.label;
  if (before.default !== spec.default) {
    const dflt = spec.default === '' ? undefined : parse(spec.type, spec.default);
    if (dflt === undefined) delete node.default;
    else node.default = dflt;
  }
  if (wasRequired !== spec.required && node.type === 'string') {
    if (spec.required) node.minLength = Math.max(1, Number(node.minLength) || 0);
    else if (node.minLength === 1) delete node.minLength;
  }
  return node;
}

/** x-order values that keep the existing ones when their sequence still holds. */
function orders(nodes: readonly (Dict | null)[]): number[] {
  const own = nodes.map((n) => (n ? orderOf(n) : undefined));
  const ok = nodes.every((n, i) => n === null || own[i] !== undefined);
  const out: number[] = [];
  if (ok) {
    let last = 0;
    for (let i = 0; i < nodes.length; i++) {
      let o = own[i];
      if (o === undefined) {
        const next = own.slice(i + 1).find((x) => x !== undefined);
        o = next === undefined || next - last > 10 ? last + 10 : (last + next) / 2;
      }
      out.push(o);
      last = o;
    }
    if (out.every((o, i) => i === 0 || o >= (out[i - 1] ?? 0))) return out;
  }
  return nodes.map((_n, i) => (i + 1) * 10);
}

/** Writes the specs back as `inputs` and `sample`, keeping everything else in the manifest. */
export function writeInputs(
  manifest: Dict,
  specs: readonly InputSpec[],
  renamed?: { from: string; to: string },
): Dict {
  const old = propsOf(manifest);
  const wasRequired =
    isRecord(manifest.inputs) && Array.isArray(manifest.inputs.required)
      ? (manifest.inputs.required as string[])
      : [];
  const was = (name: string) => (renamed && name === renamed.to ? renamed.from : name);
  const existing = specs.map((s) => {
    const node = old[was(s.name)];
    return isRecord(node) ? node : null;
  });
  const order = orders(existing);
  const oldSample = isRecord(manifest.sample) ? manifest.sample : {};
  const properties: Dict = {};
  const sample: Dict = {};
  specs.forEach((spec, i) => {
    const prior = existing[i];
    const node = prior
      ? nodeFor(spec, prior, wasRequired.includes(was(spec.name)))
      : schemaOf(spec, {}, order[i]);
    node['x-order'] = order[i];
    properties[spec.name] = node;
    const value =
      spec.type === 'list'
        ? oldSample[was(spec.name)]
        : spec.sample === ''
          ? undefined
          : parse(spec.type, spec.sample);
    if (value !== undefined) sample[spec.name] = value;
  });
  const prev = isRecord(manifest.inputs) ? manifest.inputs : {};
  const { required: _r, ...rest } = prev;
  const required = specs.filter((s) => s.required).map((s) => s.name);
  return {
    ...manifest,
    inputs: {
      ...rest,
      type: 'object',
      additionalProperties: false,
      ...(required.length ? { required } : {}),
      properties,
    },
    sample,
  };
}

const SAMPLES: Record<PickType, string> = {
  text: 'Sample',
  textarea: 'Sample text',
  number: '1',
  boolean: 'true',
  datetime: '2030-06-01T19:00:00-07:00',
  email: 'alex@example.com',
  url: 'https://example.com',
};

export function newInput(existing: readonly InputSpec[], type: PickType = 'text'): InputSpec {
  const names = existing.map((s) => s.name);
  let n = existing.length + 1;
  while (names.includes(`input${n}`)) n++;
  return {
    name: `input${n}`,
    label: `Input ${n}`,
    type,
    required: false,
    default: '',
    sample: SAMPLES[type],
  };
}

export const sampleFor = (type: PickType): string => SAMPLES[type];
