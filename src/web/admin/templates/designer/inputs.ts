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
export type InputType = (typeof INPUT_TYPES)[number]['value'];

export interface InputSpec {
  name: string;
  label: string;
  type: InputType;
  required: boolean;
  /** Text as typed; parsed by type when written. */
  default: string;
  sample: string;
}

export const NAME_PATTERN = /^[A-Za-z][A-Za-z0-9_]{0,39}$/;

/** Why a name cannot be used, or null. */
export function nameProblem(name: string, others: readonly string[]): string | null {
  if (!NAME_PATTERN.test(name)) return 'Start with a letter; use letters, digits and _ only.';
  if (name === 'pass') return '"pass" is reserved. Pick another name.';
  if (others.includes(name)) return 'Another input has this name.';
  return null;
}

function typeOf(schema: Dict): InputType {
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
      return {
        spec: {
          name,
          label: show(s['x-label']) || name,
          type: typeOf(s),
          required: required.includes(name),
          default: show(s.default),
          sample: show(sample[name]),
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

/** The JSON Schema node of one input. `existing` keeps keywords the designer does not edit. */
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

/** Writes the specs back as `inputs` and `sample`, keeping everything else in the manifest. */
export function writeInputs(manifest: Dict, specs: readonly InputSpec[]): Dict {
  const old = propsOf(manifest);
  const properties: Dict = {};
  const sample: Dict = {};
  specs.forEach((spec, i) => {
    const existing = isRecord(old[spec.name]) ? (old[spec.name] as Dict) : {};
    properties[spec.name] = schemaOf(spec, existing, (i + 1) * 10);
    const value = spec.sample === '' ? undefined : parse(spec.type, spec.sample);
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

const SAMPLES: Record<InputType, string> = {
  text: 'Sample',
  textarea: 'Sample text',
  number: '1',
  boolean: 'true',
  datetime: '2030-06-01T19:00:00-07:00',
  email: 'alex@example.com',
  url: 'https://example.com',
};

export function newInput(existing: readonly InputSpec[], type: InputType = 'text'): InputSpec {
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

export const sampleFor = (type: InputType): string => SAMPLES[type];
