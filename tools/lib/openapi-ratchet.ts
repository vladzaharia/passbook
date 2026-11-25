// SDK-name and reference-coverage rules for the committed OpenAPI document. Pure: no I/O.
import { type Doc, sunsetOf } from './openapi-diff.ts';

export interface SdkName {
  resource: string;
  method: string;
  sdk?: boolean;
  reason?: string;
}
export type SdkNames = Record<string, SdkName>;

const METHODS = ['get', 'post', 'put', 'patch', 'delete'];
export const FLAGS = [
  'description',
  'requestExample',
  'namedRequest',
  'responseExample',
  'namedResponse',
] as const;
export type Flag = (typeof FLAGS)[number];

const NAMESPACES = new Set([
  'platform',
  'nfc',
  'terminal',
  'me',
  'auth',
  'public',
  'apple',
  'googleWallet',
  'samsungWallet',
]);
const SEGMENT = /^[a-z][a-zA-Z0-9]*$/;
const TAG = /^[a-z0-9]+(-[a-z0-9]+)*$/;
const HTTP_VERB = /^(?:(?:get|post|put|patch)(?:[A-Z]|$)|delete[A-Z])/;

type Json = Record<string, unknown>;
const obj = (v: unknown): Json => (v && typeof v === 'object' ? (v as Json) : {});

interface OpInfo {
  id: string;
  path: string;
  tags: string[];
  keyReachable: boolean;
  flags: Set<Flag>;
  /** The flags that apply to this operation's shape. */
  applies: Set<Flag>;
}

const jsonOf = (content: unknown): Json | undefined =>
  obj(content)['application/json'] as Json | undefined;

function infoOf(path: string, op: Json): OpInfo {
  const security = Array.isArray(op.security) ? op.security : [];
  const flags = new Set<Flag>();
  const applies = new Set<Flag>(['description']);
  if (typeof op.description === 'string' && op.description.trim()) flags.add('description');
  const req = jsonOf(obj(op.requestBody).content);
  if (req) {
    applies.add('requestExample').add('namedRequest');
    if (req.example !== undefined) flags.add('requestExample');
    if (obj(req.schema).$ref) flags.add('namedRequest');
  }
  const ok = Object.entries(obj(op.responses)).find(([code]) => code.startsWith('2'));
  const res = jsonOf(obj(ok?.[1]).content);
  if (res) {
    applies.add('responseExample').add('namedResponse');
    if (res.example !== undefined) flags.add('responseExample');
    if (obj(res.schema).$ref) flags.add('namedResponse');
  }
  return {
    id: String(op.operationId ?? ''),
    path,
    tags: Array.isArray(op.tags) ? (op.tags as string[]) : [],
    keyReachable: security.some((s) => 'apiKey' in obj(s)),
    flags,
    applies,
  };
}

function opsOf(doc: Doc): OpInfo[] {
  return Object.entries(doc.paths ?? {}).flatMap(([path, item]) =>
    METHODS.flatMap((m) => (item[m] ? [infoOf(path, obj(item[m]))] : [])),
  );
}

function opsOfRaw(doc: Doc): [string, unknown][] {
  return Object.values(doc.paths ?? {}).flatMap((item) =>
    METHODS.flatMap((m) =>
      item[m] ? [[String(obj(item[m]).operationId ?? ''), item[m]] as [string, unknown]] : [],
    ),
  );
}

function wellFormed(id: string, n: SdkName, op: OpInfo | undefined, out: string[]): void {
  const segs = n.resource.split('.');
  const rest = NAMESPACES.has(segs[0] ?? '') ? segs.slice(1) : segs;
  const bad = (rule: string) => out.push(`${id}: ${rule}`);
  if (![...segs, n.method].every((s) => SEGMENT.test(s)))
    bad('names must match ^[a-z][a-zA-Z0-9]*$');
  if (rest.length > 2) bad('resource is at most 2 levels after the namespace');
  if (HTTP_VERB.test(n.method)) bad(`method ${n.method} starts with an HTTP verb`);
  if ([...segs, n.method].some((s) => s.includes('By'))) bad('a name contains By');
  if (op?.path.startsWith('/api/v1/platform/') && segs[0] !== 'platform')
    bad('operations under /api/v1/platform/ are platform.*');
  if (n.sdk === false) {
    if (!n.reason?.trim()) bad('sdk: false needs a reason');
    if (op?.keyReachable) bad('sdk: false on an operation that accepts apiKey');
  }
}

/** Rules 1 to 4 and 5: every failure names the operation and the rule. */
export function ratchetFailures(input: {
  base: Doc | null;
  next: Doc;
  baseNames: SdkNames | null;
  nextNames: SdkNames;
  /** Today, `YYYY-MM-DD`: a name may go with an operation the base deprecated once its `x-sunset` has come. */
  on?: string;
  /** operationIds the owner approved for removal: their frozen names may go. */
  approvedIds?: readonly string[];
}): string[] {
  const { base, next, baseNames, nextNames } = input;
  const on = input.on ?? new Date().toISOString().slice(0, 10);
  const sunsetIds = new Set(
    base
      ? opsOfRaw(base).flatMap(([id, op]) => {
          const sunset = sunsetOf(op);
          return sunset && sunset <= on ? [id] : [];
        })
      : [],
  );
  const approved = new Set(input.approvedIds ?? []);
  const out: string[] = [];
  const nextOps = opsOf(next);
  const byId = new Map(nextOps.map((o) => [o.id, o]));

  if (baseNames) {
    for (const [id, was] of Object.entries(baseNames)) {
      const now = nextNames[id];
      if (!now && approved.has(id) && !byId.has(id)) continue;
      if (!now) {
        if (!sunsetIds.has(id) || nextOps.some((o) => o.id === id))
          out.push(`${id}: name removed (names are frozen)`);
      } else if (now.resource !== was.resource || now.method !== was.method)
        out.push(
          `${id}: renamed ${was.resource}.${was.method} to ${now.resource}.${now.method} (names are frozen)`,
        );
      else if (was.sdk !== false && now.sdk === false)
        out.push(`${id}: sdk true to false is a removal`);
    }
  }

  for (const op of nextOps)
    if (!nextNames[op.id])
      out.push(`${op.id}: add ${op.id} to docs/api/sdk-names.json (DevEx names it)`);
  for (const id of Object.keys(nextNames))
    if (!byId.has(id)) out.push(`${id}: name has no operation`);

  const pairs = new Map<string, string>();
  for (const [id, n] of Object.entries(nextNames)) {
    wellFormed(id, n, byId.get(id), out);
    const pair = `${n.resource}.${n.method}`;
    const other = pairs.get(pair);
    if (other) out.push(`${id}: ${pair} is also ${other}`);
    pairs.set(pair, id);
  }

  for (const op of nextOps)
    for (const tag of op.tags)
      if (!TAG.test(tag)) out.push(`${op.id}: tag "${tag}" is not kebab-case`);

  if (base) {
    const before = new Map(opsOf(base).map((o) => [o.id, o]));
    for (const op of nextOps) {
      const was = before.get(op.id);
      for (const flag of op.applies) {
        if (!was && op.keyReachable && !op.flags.has(flag))
          out.push(`${op.id}: new key-callable operation needs ${flag}`);
        if (was?.flags.has(flag) && !op.flags.has(flag))
          out.push(`${op.id}: coverage dropped, ${flag} was set`);
      }
    }
  }
  return out;
}

/** Per flag: key-reachable operations that have it, over those it applies to. */
export function coverage(doc: Doc): Record<Flag, [number, number]> {
  const counts = Object.fromEntries(FLAGS.map((f) => [f, [0, 0]])) as Record<
    Flag,
    [number, number]
  >;
  for (const op of opsOf(doc).filter((o) => o.keyReachable))
    for (const flag of op.applies) {
      counts[flag][1]++;
      if (op.flags.has(flag)) counts[flag][0]++;
    }
  return counts;
}
