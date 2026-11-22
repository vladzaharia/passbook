// Content rules for the examples in the committed OpenAPI document: a schema-valid example can still be filler.
// Pure: no I/O. Run by check-openapi; the generator (tools/gen-reference-examples.ts) reruns until it is clean.
import { IDS } from './example-world.ts';
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
  'ab12cd34',
  'abcd',
  'a1b2c3d4',
  'foo',
  'bar',
  'baz',
  'todo',
  'tbd',
  'n/a',
  'changeme',
  'lorem ipsum',
]);
/** Words that mark text nobody wrote for this example. */
const FILLER_WORDS =
  /lorem|ipsum|\bfoo\b|\bTODO\b|\bTBD\b|changeme|\b(?:john|jane) doe\b|placeholder/i;
/** Shapes secret scanners (gitleaks, GitHub) report. Our own secrets use test-mode prefixes only. */
const SECRET_SHAPES: [RegExp, string][] = [
  [/ya29\./, 'a Google OAuth token'],
  [/\bsk_live_/, 'a live secret key'],
  [/\bAKIA[0-9A-Z]{16}\b/, 'an AWS access key'],
  [/\beyJ[A-Za-z0-9_-]{8,}\.eyJ[A-Za-z0-9_-]{8,}\./, 'a JWT'],
  [/\bpb[po]?_live_/, 'a live-prefixed key'],
  [/\bgh[pousr]_[A-Za-z0-9]{36}/, 'a GitHub token'],
  [/\bxox[baprs]-/, 'a Slack token'],
  [/whsec_(?!demo_northwind_)/, 'a webhook secret that is not marked demo'],
  [/\bpb_test_[A-Za-z0-9_-]{8}_[A-Za-z0-9_-]{43}$/, 'a test key our own parser accepts'],
  [/-----BEGIN [A-Z ]*PRIVATE KEY-----[^-]{40,}-----END/, 'a whole PEM key'],
];
/** A key or value with case and separators removed, to compare a value with its own field name. */
const squash = (text: string): string => text.toLowerCase().replace(/[^a-z0-9]/g, '');
const WORLD_IDS = new Set(Object.values(IDS));
/** The entity a key names: `templateId` and `template` are `template`; every actor key is a `user`. */
const entityOf = (key: string): string =>
  /^(?:createdBy|updatedBy|startedBy|endedBy|requestedBy|actorId|ownerUserId|hostUserId|userId|approvedBy)$/.test(
    key,
  )
    ? 'user'
    : key === 'id'
      ? 'self'
      : key
          .replace(/Ids?$/, '')
          .replace(/^.*(?=[A-Z])/, '')
          .toLowerCase();

/** Where a person's name is the right content. */
const PERSON =
  /input|personali[sz]ation|holder|host|visitor|member|person|staff|user|people|owner|invitee|sample|primaryFields|secondaryFields|auxiliaryFields|passJson|csv|subtitle|ownerName|rows/i;
/** Keys that hold a resource's own name, where a person's name is wrong. */
const RESOURCE_NAME =
  /^(name|label|title|description)$|^(org|template|scanner|device|type|connection|keyset|zone|event|key|identity|asset)Names?$|Label$/;
/** Words from an earlier sample world; every example describes Northwind Climbing now. */
const FOREIGN = /Harbor|Example Events|TICKET-|Event ticket|Acme|Henry/i;
const TIME_KEY = /(?:At|Until|From|Since|Before|After|On)$|^(?:at|serverNow|when)$/;
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
      if (Array.isArray(v)) for (const [i, x] of v.entries()) mapKeys(x, `${at}[${i}]`);
      else if (v && typeof v === 'object')
        for (const [k, x] of Object.entries(v)) {
          if (FILLERS.has(k.toLowerCase())) bad(`the key "${k}" is filler`, `${at}.${k}`);
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
        if (v.length > 1 && squash(v) === squash(leaf.key) && leaf.key !== '')
          bad(`"${v}" is just the field name`, at);
        if (FOREIGN.test(v)) bad(`"${v.slice(0, 40)}" is from another sample world`, at);
        if (FILLERS.has(v.toLowerCase()) && !(v === 'string' && leaf.key === 'type'))
          bad(`"${v}" is filler`, at);
        if (FILLER_WORDS.test(v)) bad(`"${v.slice(0, 40)}" is filler text`, at);
        for (const [re, what] of SECRET_SHAPES)
          if (re.test(v)) bad(`"${v.slice(0, 24)}…" looks like ${what}`, at);
        if (UUID.test(v) && /0{8,}[0-9a-f]{0,4}$/.test(v.slice(24)) && !WORLD_IDS.has(v))
          bad(`"${v}" is a zero-padded id`, at);
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
  for (const ex of examples) {
    for (const m of objectFailures(ex.value, '')) out.push(`${ex.where}${m}`);
    for (const m of ownIdReuse(ex.value)) out.push(`${ex.where}${m}`);
  }
  for (const [value, ops] of patterned)
    if (ops.size >= 4) out.push(`"${value}" is a regex sample reused by ${ops.size} operations`);
  return out;
}

/** Rules that read one object at a time: ids under two entities, filler numbers, a secret that does not match its prefix. */
function objectFailures(value: unknown, at: string): string[] {
  const out: string[] = [];
  if (Array.isArray(value)) {
    for (const [i, v] of value.entries()) out.push(...objectFailures(v, `${at}[${i}]`));
    return out;
  }
  if (!value || typeof value !== 'object') return out;
  const o = value as Json;
  const owner = new Map<string, string>();
  const numbers: number[] = [];
  for (const [k, v] of Object.entries(o)) {
    if (typeof v === 'string' && UUID.test(v)) {
      const seen = owner.get(v);
      if (seen && seen !== entityOf(k))
        out.push(`${at}.${k}: the id ${v} is also the ${seen} id in this object`);
      else owner.set(v, entityOf(k));
    }
    if (typeof v === 'number' && Number.isInteger(v) && v < 1_000_000_000_000) numbers.push(v);
  }
  if (numbers.length >= 3 && (numbers.every((n) => n === 1) || numbers.every((n) => n === 3)))
    out.push(`${at}: every number is ${numbers[0]}, which reads as filler`);
  const repeated = [...new Set(numbers.filter((n) => n >= 2))].filter(
    (n) => numbers.filter((m) => m === n).length >= 3,
  );
  for (const n of repeated)
    out.push(`${at}: three sibling numbers are all ${n}, which reads as filler`);
  out.push(...invariantFailures(o, at));
  if (typeof o.prefix === 'string' && o.secretPrefix === o.prefix)
    out.push(`${at}.prefix: equals secretPrefix; the prefix is the part after the label`);
  if (typeof o.secret === 'string' && typeof o.prefix === 'string') {
    const head = typeof o.secretPrefix === 'string' ? o.secretPrefix : o.prefix;
    if (!o.secret.startsWith(head)) out.push(`${at}.secret: does not start with "${head}"`);
  }
  for (const [k, v] of Object.entries(o)) out.push(...objectFailures(v, `${at}.${k}`));
  return out;
}

const START = /^(.*?)(From|Start|Starts|Opens|Since)(At)?$/i;
const END = /^(.*?)(Until|End|Ends|Closes|Before)(At)?$/i;
const FINAL_STATES = /^(delivered|succeeded|sent|done|completed|finished|ok|paired|healthy)$/;
const GONE_AT =
  /^(closedAt|revokedAt|disabledAt|removedAt|deletedAt|archivedAt|failingSince|retireAt)$/;
const num = (v: unknown): number | undefined => (typeof v === 'number' ? v : undefined);

/** Fields of one object that cannot all be true together. Each rule is generic: pairs, states and totals. */
function invariantFailures(o: Json, at: string): string[] {
  const out: string[] = [];
  const entries = Object.entries(o);
  for (const [k, v] of entries) {
    const a = START.exec(k);
    if (!a || num(v) === undefined) continue;
    for (const [k2, v2] of entries) {
      const b = END.exec(k2);
      if (b && b[1] === a[1] && num(v2) !== undefined && (v as number) >= (v2 as number))
        out.push(`${at}: ${k} (${v}) must be before ${k2} (${v2})`);
    }
  }
  const last = [num(o.lastSuccessAt), num(o.lastFailureAt)];
  if (last[0] !== undefined && last[0] === last[1])
    out.push(`${at}: lastSuccessAt and lastFailureAt are the same instant`);
  const state =
    typeof o.state === 'string' ? o.state : typeof o.status === 'string' ? o.status : '';
  if (state === 'active')
    for (const [k, v] of entries)
      if (GONE_AT.test(k) && v !== null && v !== undefined)
        out.push(`${at}: ${k} is set on an active record`);
  if (FINAL_STATES.test(state) && o.nextAt !== undefined && o.nextAt !== null)
    out.push(`${at}: nextAt is set on a ${state} record`);
  if (state === 'delivered' && 'lastStatus' in o && o.lastStatus === null)
    out.push(`${at}: a delivered record has no lastStatus`);
  if (state === 'delivered' && (num(o.replays) ?? 0) > 5)
    out.push(`${at}: replays ${o.replays} is too many for one delivery`);
  if (/^(pending|queued|running|scheduled)$/.test(state) && num(o.finishedAt) !== undefined)
    out.push(`${at}: finishedAt is set on a ${state} record`);
  if (state === 'failed' && 'errorCode' in o && o.errorCode === null)
    out.push(`${at}: a failed record has no errorCode`);
  for (const born of ['createdAt', 'receivedAt'])
    if (
      num(o.updatedAt) !== undefined &&
      num(o[born]) !== undefined &&
      (o.updatedAt as number) < (o[born] as number)
    )
      out.push(`${at}: updatedAt is before ${born}`);
  for (const k of ['status', 'httpStatus', 'lastStatus'])
    if (typeof o[k] === 'number' && (o[k] as number) > 0 && (o[k] as number) < 100)
      out.push(`${at}: ${k} ${o[k]} is not an HTTP status`);
  const seen = num(o.recordsSeen);
  const failed = num(o.recordsFailed);
  if (seen !== undefined && failed !== undefined && failed > seen)
    out.push(`${at}: recordsFailed (${failed}) exceeds recordsSeen (${seen})`);
  if (o.outcome === 'unchanged')
    for (const [k, v] of entries)
      if (/Changed$/.test(k) && typeof v === 'number' && v !== 0)
        out.push(`${at}: ${k} is ${v} on an unchanged run`);
  const total = num(o.total);
  if (total !== undefined) {
    const parts = entries.filter(
      ([k, v]) =>
        /^(done|failed|created|updated|unchanged|skipped|removed|ok|errors|refused)$/.test(k) &&
        num(v) !== undefined,
    );
    const sum = parts.reduce((n, [, v]) => n + (v as number), 0);
    if (parts.length >= 2 && sum !== total)
      out.push(`${at}: the parts add up to ${sum}, not total ${total}`);
  }
  return out;
}

/** An object's `id` must not be the `id` of a differently shaped object elsewhere in the same example. */
export function ownIdReuse(value: unknown): string[] {
  const seen = new Map<string, { at: string; shape: string }>();
  const out: string[] = [];
  const walkIds = (v: unknown, at: string): void => {
    if (Array.isArray(v)) {
      for (const [i, x] of v.entries()) walkIds(x, `${at}[${i}]`);
      return;
    }
    if (!v || typeof v !== 'object') return;
    const o = v as Json;
    if (typeof o.id === 'string' && UUID.test(o.id)) {
      const shape = Object.keys(o).sort().join(',');
      const was = seen.get(o.id);
      if (was && was.shape !== shape)
        out.push(`${at}.id: the id ${o.id} is also the id of ${was.at}`);
      else if (!was) seen.set(o.id, { at: at || 'the example', shape });
    }
    for (const [k, x] of Object.entries(o)) walkIds(x, `${at}.${k}`);
  };
  walkIds(value, '');
  return out;
}
