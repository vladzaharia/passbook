import type { Sent } from './copy-as.ts';
import type { Json, RunOp, RunSchema } from './types.ts';
import { type Issue, validate } from './validate.ts';

/** What the person has typed: the parameters, the body as text, and the idempotency chip. */
export interface Draft {
  path: Record<string, string>;
  query: Record<string, string>;
  header: Record<string, string>;
  /** The JSON body as text; empty when the operation has none. */
  body: string;
  idemOn: boolean;
  idemKey: string;
}

export const newKey = (): string => crypto.randomUUID();

const EMPTY: Record<string, Json> = {
  string: '',
  integer: 0,
  number: 0,
  boolean: false,
  array: [],
  object: {},
};

/** A body to start from when the document has no example: the required fields, empty. */
export function skeleton(schema: RunSchema): Json {
  if (schema.enum?.[0] !== undefined) return schema.enum[0];
  const t = Array.isArray(schema.type) ? schema.type[0] : schema.type;
  if (t === 'object' || schema.properties) {
    const out: Record<string, Json> = {};
    for (const key of schema.required ?? []) out[key] = skeleton(schema.properties?.[key] ?? {});
    return out;
  }
  return EMPTY[t ?? ''] ?? null;
}

const isObject = (v: Json | undefined): v is Record<string, Json> =>
  v !== null && typeof v === 'object' && !Array.isArray(v);

/**
 * Examples show the sandbox's own template, so the first Run works: its id, and its `sample` as the `input` of
 * any body that names a template.
 */
export function swapTemplate(value: Json, templateId: string | null, sample?: Json): Json {
  if (!templateId || value === null || typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.map((v) => swapTemplate(v, templateId, sample));
  const names = typeof value.templateId === 'string';
  return Object.fromEntries(
    Object.entries(value).map(([k, v]) => [
      k,
      k === 'templateId' && typeof v === 'string'
        ? templateId
        : k === 'input' && names && sample !== undefined && isObject(v)
          ? sample
          : swapTemplate(v, templateId, sample),
    ]),
  );
}

export function initialDraft(op: RunOp, templateId: string | null = null, sample?: Json): Draft {
  const body = op.body ? (op.example ?? skeleton(op.body)) : undefined;
  return {
    path: {},
    query: {},
    header: {},
    body: body === undefined ? '' : JSON.stringify(swapTemplate(body, templateId, sample), null, 2),
    idemOn: op.idempotent,
    idemKey: newKey(),
  };
}

export type Parsed = { ok: true; value: Json | undefined } | { ok: false; message: string };

export function parseBody(text: string): Parsed {
  if (text.trim() === '') return { ok: true, value: undefined };
  try {
    return { ok: true, value: JSON.parse(text) as Json };
  } catch (e) {
    return { ok: false, message: e instanceof SyntaxError ? e.message : 'Not valid JSON.' };
  }
}

/** The sandbox template's input schema, to check `input` against. */
export interface InputCheck {
  templateId: string;
  schema: RunSchema;
}

/** True when the body takes a template: it declares `templateId` or a free-form `input`. */
export function takesTemplate(op: RunOp): boolean {
  const props = op.body?.properties;
  return Boolean(props?.templateId || (props?.input && !props.input.properties));
}

/** The template the request is about: the body's `templateId`, or the `{id}` of a `/templates/{id}` path. */
function namedTemplate(op: RunOp, draft: Draft): Json | undefined {
  const parsed = parseBody(draft.body);
  const named = parsed.ok && isObject(parsed.value) ? parsed.value.templateId : undefined;
  return named ?? (op.path.includes('/templates/{id}') ? draft.path.id : undefined);
}

/** The body's `input` object, when the operation's own `input` is free-form (a template's fields, not a fixed shape). */
function inputOf(op: RunOp, draft: Draft): Record<string, Json> | undefined {
  const own = op.body?.properties?.input;
  if (!own || own.properties) return undefined;
  const parsed = parseBody(draft.body);
  return parsed.ok && isObject(parsed.value) && isObject(parsed.value.input)
    ? parsed.value.input
    : undefined;
}

/** True when the body holds a free-form `input` that the sandbox template's schema has not checked. */
export function inputUnchecked(op: RunOp, draft: Draft, check?: InputCheck): boolean {
  return Boolean(inputOf(op, draft)) && (!check || namedTemplate(op, draft) !== check.templateId);
}

/** Everything wrong before sending: missing parameters and the body against the schema. */
export function problems(op: RunOp, draft: Draft, check?: InputCheck): Issue[] {
  const out: Issue[] = [];
  for (const p of op.params) {
    const v = draft[p.where][p.name] ?? '';
    // `.` and `..` are path segments, not ids: the URL would point somewhere else.
    if (p.where === 'path' && (v === '.' || v === '..')) {
      out.push({ path: p.name, message: 'is not a valid id' });
      continue;
    }
    if (v === '') {
      if (p.required) out.push({ path: p.name, message: 'is required' });
      continue;
    }
    const num = p.schema.type === 'integer' || p.schema.type === 'number';
    out.push(...validate(p.schema, num && !Number.isNaN(Number(v)) ? Number(v) : v, p.name));
  }
  if (op.body) {
    const parsed = parseBody(draft.body);
    if (!parsed.ok) out.push({ path: 'body', message: parsed.message });
    else if (parsed.value === undefined) {
      if ((op.body.required?.length ?? 0) > 0) out.push({ path: 'body', message: 'is required' });
    } else out.push(...validate(op.body, parsed.value));
    const input = inputOf(op, draft);
    if (input && check && !inputUnchecked(op, draft, check))
      out.push(...validate(check.schema, input, 'input'));
  }
  return out;
}

/** The path with its parameters in and the query string on. */
export function target(op: RunOp, draft: Draft): string {
  const path = op.path.replace(/\{(\w+)\}/g, (_, name: string) => {
    const given = draft.path[name];
    return given ? encodeURIComponent(given) : `<${name}>`;
  });
  const q = new URLSearchParams();
  for (const [k, v] of Object.entries(draft.query)) if (v !== '') q.set(k, v);
  return q.size > 0 ? `${path}?${q}` : path;
}

function extraHeaders(op: RunOp, draft: Draft): [string, string][] {
  const out: [string, string][] = [];
  for (const p of op.params)
    if (p.where === 'header' && (draft.header[p.name] ?? '') !== '')
      out.push([p.name, draft.header[p.name] as string]);
  if (op.idempotent && draft.idemOn && draft.idemKey) out.push(['Idempotency-Key', draft.idemKey]);
  return out;
}

/** The request without its key: what Copy as shows, and what the Inspector says was sent. */
export function buildSent(op: RunOp, draft: Draft, origin: string): Sent {
  const parsed = parseBody(draft.body);
  return {
    method: op.method.toUpperCase(),
    url: `${origin}${target(op, draft)}`,
    headers: extraHeaders(op, draft),
    ...(parsed.ok && parsed.value !== undefined && op.body ? { body: parsed.value } : {}),
  };
}

/** What `fetch` gets, minus the key the sender adds. The path stays on this origin. */
export function wireOf(
  op: RunOp,
  draft: Draft,
): { path: string; headers: Record<string, string>; body?: string } {
  const sent = buildSent(op, draft, '');
  const headers: Record<string, string> = { accept: 'application/json' };
  for (const [k, v] of sent.headers) headers[k] = v;
  if (sent.body !== undefined) headers['content-type'] = 'application/json';
  return {
    path: sent.url,
    headers,
    ...(sent.body !== undefined ? { body: JSON.stringify(sent.body) } : {}),
  };
}
