// Content rules for the examples in the committed OpenAPI document: a schema-valid example can still be filler.
// Pure: no I/O. Run by check-openapi; the generator (tools/gen-reference-examples.ts) reruns until it is clean.
import type { Doc } from './openapi-diff.ts';

type Json = Record<string, unknown>;
const obj = (v: unknown): Json => (v && typeof v === 'object' ? (v as Json) : {});

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const UUID_V7 = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
/** Values a sampler writes when it has nothing real to say. */
const FILLERS = new Set([
  'example',
  'string',
  'example-key',
  'abc123',
  'AB12CD34',
  'ABCD',
  'a1b2c3d4',
]);
/** Where a person's name is the right content. */
const PERSON =
  /input|personali[sz]ation|holder|host|visitor|member|person|staff|user|people|owner|invitee|sample|primaryFields|secondaryFields|auxiliaryFields|passJson|csv|subtitle|ownerName|rows/i;
/** Keys that hold a resource's own name, where a person's name is wrong. */
const RESOURCE_NAME =
  /^(name|label|title|description)$|^(org|template|scanner|device|type|connection|keyset|zone|event|key|identity|asset)Names?$|Label$/;
/** Words from an earlier sample world; every example describes Northwind Climbing now. */
const FOREIGN = /Harbor|Example Events|TICKET-|Event ticket|Acme|Henry/i;
const TIME_KEY = /(?:At|Until|From|Since|Before|After)$/;
const ID_KEY = /^id$|Id$|^serial$|^serialNumber$/;

export interface Example {
  where: string;
  value: unknown;
  schema: unknown;
  /** The operation it belongs to, for the reuse rule. */
  op: string;
}

const refName = (ref: string): string => ref.slice(ref.lastIndexOf('/') + 1);

function resolve(doc: Doc, schema: unknown): Json {
  let cur = obj(schema);
  for (let i = 0; i < 20 && typeof cur.$ref === 'string'; i++)
    cur = obj(obj(obj(doc.components).schemas)[refName(cur.$ref as string)]);
  const named = Array.isArray(cur.allOf) ? cur.allOf.find((s) => obj(s).$ref) : undefined;
  return named ? resolve(doc, named) : cur;
}

/** Every request and response example on a JSON body of an operation a key may call. */
export function examplesOf(doc: Doc): Example[] {
  const out: Example[] = [];
  for (const [path, item] of Object.entries(doc.paths ?? {}))
    for (const [method, raw] of Object.entries(item)) {
      const op = obj(raw);
      if (!Array.isArray(op.security) || !op.security.some((s) => 'apiKey' in obj(s))) continue;
      const id = String(op.operationId ?? `${method} ${path}`);
      const req = obj(obj(obj(op.requestBody).content)['application/json']);
      if (req.example !== undefined)
        out.push({ where: `${id} request`, value: req.example, schema: req.schema, op: id });
      for (const [name, variant] of Object.entries(obj(req.examples)))
        out.push({
          where: `${id} requests[${name}]`,
          value: obj(variant).value,
          schema: req.schema,
          op: id,
        });
      const ok = Object.entries(obj(op.responses)).find(([code]) => code.startsWith('2'));
      const res = obj(obj(obj(ok?.[1]).content)['application/json']);
      if (res.example !== undefined)
        out.push({ where: `${id} response`, value: res.example, schema: res.schema, op: id });
    }
  return out;
}

interface Leaf {
  path: string;
  key: string;
  value: unknown;
  schema: Json;
}

function* walk(
  doc: Doc,
  value: unknown,
  schema: unknown,
  path: string,
  key: string,
): Generator<Leaf> {
  const s = resolve(doc, schema);
  if (Array.isArray(value)) {
    const items = obj(s.items);
    for (const [i, v] of value.entries())
      yield* walk(
        doc,
        v,
        s.prefixItems ? (s.prefixItems as unknown[])[i] : items,
        `${path}[${i}]`,
        key,
      );
    return;
  }
  if (value && typeof value === 'object') {
    const props = obj(s.properties);
    const entries = Object.entries(value as Json);
    if (!entries.length && Object.keys(props).length) yield { path, key, value, schema: s };
    const alts = [...((s.oneOf as unknown[]) ?? []), ...((s.anyOf as unknown[]) ?? [])];
    for (const [k, v] of entries) {
      const sub =
        props[k] ??
        (alts.length
          ? alts.map((a) => obj(resolve(doc, a).properties)[k]).find(Boolean)
          : undefined) ??
        s.additionalProperties;
      yield* walk(doc, v, sub, `${path}.${k}`, k);
    }
    return;
  }
  yield { path, key, value, schema: s };
}

/** One message per broken rule; empty when every example reads like real traffic. */
export function exampleFailures(doc: Doc, examples: Example[] = examplesOf(doc)): string[] {
  const out: string[] = [];
  const patterned = new Map<string, Set<string>>();
  for (const ex of examples) {
    const bad = (why: string, at: string) => out.push(`${ex.where}${at}: ${why}`);
    const mapKeys = (v: unknown, at: string): void => {
      if (Array.isArray(v)) v.forEach((x, i) => mapKeys(x, `${at}[${i}]`));
      else if (v && typeof v === 'object')
        for (const [k, x] of Object.entries(v)) {
          if (FILLERS.has(k)) bad(`the key "${k}" is filler`, `${at}.${k}`);
          mapKeys(x, `${at}.${k}`);
        }
    };
    mapKeys(ex.value, '');
    for (const leaf of walk(doc, ex.value, ex.schema, '', '')) {
      const at = leaf.path;
      const v = leaf.value;
      if (v && typeof v === 'object') {
        bad('an empty {} where the schema has properties', at);
        continue;
      }
      if (typeof v === 'string') {
        if (FOREIGN.test(v)) bad(`"${v.slice(0, 40)}" is from another sample world`, at);
        if (FILLERS.has(v) && !(v === 'string' && leaf.key === 'type')) bad(`"${v}" is filler`, at);
        if (/Ada/.test(v) && RESOURCE_NAME.test(leaf.key) && !PERSON.test(ex.op + at))
          bad(`person name "${v}" in a field that is not a person`, at);
        if (
          /(.)\1{7,}/.test(
            v.replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi, ''),
          )
        )
          bad(`"${v}" repeats one character`, at);
        const mail = v.match(/[\w.+-]+@([\w.-]+)/);
        if (
          mail &&
          mail[1] !== 'example.com' &&
          !/\.(?:png|jpe?g|gif|svg|webp)$/i.test(mail[1] ?? '')
        )
          bad(`email "${v}" is not at example.com`, at);
        if (ID_KEY.test(leaf.key) && UUID.test(v) && !UUID_V7.test(v))
          bad(`"${v}" is not a UUIDv7`, at);
        if (
          ID_KEY.test(leaf.key) &&
          /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-/.test(v) &&
          !UUID.test(v)
        )
          bad(`"${v}" is a truncated UUID`, at);
        if (
          typeof leaf.schema.pattern === 'string' &&
          /^(?:[0-9a-f]{8}|[A-Z0-9]{4,8}|\d{6})$/.test(v)
        ) {
          const set = patterned.get(v) ?? new Set<string>();
          set.add(ex.op);
          patterned.set(v, set);
        }
      }
      if (typeof v === 'number' && TIME_KEY.test(leaf.key) && v < 1_000_000_000_000)
        bad(`time ${v} is not a plausible millisecond time`, at);
    }
  }
  for (const [value, ops] of patterned)
    if (ops.size >= 4) out.push(`"${value}" is a regex sample reused by ${ops.size} operations`);
  return out;
}
