// Breaking-change rules for the committed OpenAPI document. Pure: no I/O.
type Json = Record<string, unknown>;
export type Doc = { paths?: Record<string, Record<string, unknown>>; components?: Json } & Json;

const METHODS = ['get', 'post', 'put', 'patch', 'delete'];
const obj = (v: unknown): Json => (v && typeof v === 'object' ? (v as Json) : {});

function deref(doc: Doc, node: unknown, depth = 0): Json {
  let cur = obj(node);
  for (let i = 0; i < 20 && typeof cur.$ref === 'string'; i++) {
    const target = (cur.$ref as string)
      .replace(/^#\//, '')
      .split('/')
      .reduce<unknown>((acc, k) => obj(acc)[k], doc);
    cur = obj(target);
  }
  // A nullable named schema is `allOf: [{ $ref }, { type: [..., 'null'] }]`: read it as the named schema.
  const named = Array.isArray(cur.allOf) ? cur.allOf.find((s) => obj(s).$ref) : undefined;
  return named && depth < 20 ? deref(doc, named, depth + 1) : cur;
}

type Side = 'request' | 'response';

/** Response: a removed field or enum value breaks. Request: a new required field, a removed enum value or a now-closed object does. */
function compare(
  a: Doc,
  b: Doc,
  oldNode: unknown,
  newNode: unknown,
  side: Side,
  where: string,
  out: string[],
  seen = new Set<string>(),
): void {
  const o = deref(a, oldNode);
  const n = deref(b, newNode);
  const ref = obj(oldNode).$ref;
  if (typeof ref === 'string') {
    const key = `${where}|${ref}`;
    if (seen.has(key)) return;
    seen.add(key);
  }
  const oEnum = Array.isArray(o.enum) ? (o.enum as unknown[]) : null;
  const nEnum = Array.isArray(n.enum) ? (n.enum as unknown[]) : null;
  if (oEnum && nEnum) {
    for (const v of oEnum)
      if (!nEnum.includes(v)) out.push(`${where}: enum value ${JSON.stringify(v)} removed`);
  } else if (!oEnum && nEnum && side === 'request') out.push(`${where}: now restricted to an enum`);
  const oProps = obj(o.properties);
  const nProps = obj(n.properties);
  for (const [name, schema] of Object.entries(oProps)) {
    if (!(name in nProps)) {
      out.push(`${where}.${name}: ${side === 'response' ? 'field' : 'input field'} removed`);
      continue;
    }
    compare(a, b, schema, nProps[name], side, `${where}.${name}`, out, seen);
  }
  // A request object that used to drop an unknown key and now refuses it breaks a client that sends one.
  if (side === 'request' && n.additionalProperties === false && o.additionalProperties !== false)
    out.push(`${where}: unknown keys now refused`);
  if (side === 'request') {
    const oReq = new Set((o.required as string[] | undefined) ?? []);
    for (const name of (n.required as string[] | undefined) ?? [])
      if (!oReq.has(name)) out.push(`${where}.${name}: now required`);
  }
  if (o.items && n.items) compare(a, b, o.items, n.items, side, `${where}[]`, out, seen);
  for (const key of ['anyOf', 'oneOf', 'allOf'] as const) {
    const oList = o[key];
    const nList = n[key];
    if (Array.isArray(oList) && Array.isArray(nList) && oList.length === nList.length)
      for (const [i, s] of oList.entries())
        compare(a, b, s, nList[i], side, `${where}|${i}`, out, seen);
  }
}

const paramMap = (doc: Doc, op: Json): Map<string, Json> =>
  new Map(
    ((op.parameters as unknown[]) ?? []).map((p) => {
      const d = deref(doc, p);
      return [`${d.in}:${d.name}`, d];
    }),
  );

function compareOperation(a: Doc, b: Doc, id: string, oldOp: Json, newOp: Json, out: string[]) {
  const oParams = paramMap(a, oldOp);
  for (const [key, np] of paramMap(b, newOp)) {
    const op = oParams.get(key);
    if (!op) {
      if (np.required) out.push(`${id}: new required parameter ${key}`);
      continue;
    }
    if (!op.required && np.required) out.push(`${id}: parameter ${key} now required`);
    compare(a, b, op.schema, np.schema, 'request', `${id} param ${key}`, out);
  }
  const oReq = obj(oldOp.requestBody);
  const nReq = obj(newOp.requestBody);
  const oBody = obj(obj(oReq.content)['application/json']).schema;
  const nBody = obj(obj(nReq.content)['application/json']).schema;
  if (!oReq.required && nReq.required) out.push(`${id}: request body now required`);
  if (oBody && nBody) compare(a, b, oBody, nBody, 'request', `${id} body`, out);
  else if (oBody) out.push(`${id}: request body removed`);
  const nRes = obj(newOp.responses);
  for (const [status, res] of Object.entries(obj(oldOp.responses))) {
    if (!status.startsWith('2')) continue;
    if (!(status in nRes)) {
      out.push(`${id}: response ${status} removed`);
      continue;
    }
    const os = obj(obj(obj(res).content)['application/json']).schema;
    const ns = obj(obj(obj(nRes[status]).content)['application/json']).schema;
    if (os && ns) compare(a, b, os, ns, 'response', `${id} ${status}`, out);
    else if (os) out.push(`${id}: response ${status} body removed`);
  }
}

/** Every way `next` breaks a client written against `prev`. */
export function breakingChanges(prev: Doc, next: Doc): string[] {
  const out: string[] = [];
  for (const [path, item] of Object.entries(prev.paths ?? {})) {
    for (const method of METHODS) {
      const oldOp = obj(item)[method];
      if (!oldOp) continue;
      const id = `${method.toUpperCase()} ${path}`;
      const newOp = obj(obj(next.paths?.[path])[method]);
      if (!Object.keys(newOp).length) {
        out.push(`${id}: operation removed`);
        continue;
      }
      const oid = obj(oldOp).operationId;
      if (oid && newOp.operationId !== oid) out.push(`${id}: operationId ${String(oid)} changed`);
      compareOperation(prev, next, id, obj(oldOp), newOp, out);
    }
  }
  return out;
}

/** One operation the owner approved for outright removal (tools/openapi-approved-removals.json). */
export interface ApprovedRemoval {
  /** `GET /api/v1/visitors`, as the document names it. */
  op: string;
  operationId: string;
  date: string;
  reason: string;
}

/** The breaking changes left once approved operation removals are set aside. */
export const withoutApprovedRemovals = (
  broken: string[],
  approved: ApprovedRemoval[],
): string[] => {
  const free = new Set(approved.map((a) => `${a.op}: operation removed`));
  return broken.filter((b) => !free.has(b));
};

export interface Change {
  operationId: string;
  /** `GET /passes/{id}`. */
  op: string;
  /** `additive`: safe for old clients. `notable`: safe, but a client with a closed switch may care (new output enum value). */
  class: 'additive' | 'notable' | 'breaking';
  text: string;
}

/** What `next` adds for a client written against `prev`: the safe side of breakingChanges. */
function added(
  a: Doc,
  b: Doc,
  oldNode: unknown,
  newNode: unknown,
  side: Side,
  where: string,
  out: Omit<Change, 'op' | 'operationId'>[],
  seen = new Set<string>(),
): void {
  const o = deref(a, oldNode);
  const n = deref(b, newNode);
  const ref = obj(oldNode).$ref;
  if (typeof ref === 'string') {
    const key = `${where}|${ref}`;
    if (seen.has(key)) return;
    seen.add(key);
  }
  if (Array.isArray(o.enum) && Array.isArray(n.enum))
    for (const v of n.enum as unknown[])
      if (!(o.enum as unknown[]).includes(v))
        out.push({
          class: side === 'response' ? 'notable' : 'additive',
          text: `${where}: enum value ${JSON.stringify(v)} added`,
        });
  const oProps = obj(o.properties);
  const nProps = obj(n.properties);
  for (const [name, schema] of Object.entries(nProps)) {
    if (name in oProps) added(a, b, oProps[name], schema, side, `${where}.${name}`, out, seen);
    else
      out.push({
        class: 'additive',
        text: `${where}.${name}: ${side === 'response' ? 'field' : 'optional input field'} added`,
      });
  }
  if (o.items && n.items) added(a, b, o.items, n.items, side, `${where}[]`, out, seen);
  for (const key of ['anyOf', 'oneOf', 'allOf'] as const) {
    const oList = o[key];
    const nList = n[key];
    if (Array.isArray(oList) && Array.isArray(nList) && oList.length === nList.length)
      for (const [i, s] of oList.entries())
        added(a, b, s, nList[i], side, `${where}|${i}`, out, seen);
  }
}

function addedInOperation(a: Doc, b: Doc, oldOp: Json, newOp: Json) {
  const out: Omit<Change, 'op' | 'operationId'>[] = [];
  const oParams = paramMap(a, oldOp);
  for (const [key, np] of paramMap(b, newOp)) {
    const op = oParams.get(key);
    if (!op) {
      if (!np.required) out.push({ class: 'additive', text: `optional parameter ${key} added` });
    } else added(a, b, op.schema, np.schema, 'request', `param ${key}`, out);
  }
  const oBody = obj(obj(obj(oldOp.requestBody).content)['application/json']).schema;
  const nBody = obj(obj(obj(newOp.requestBody).content)['application/json']).schema;
  if (oBody && nBody) added(a, b, oBody, nBody, 'request', 'body', out);
  const nRes = obj(newOp.responses);
  for (const [status, res] of Object.entries(obj(oldOp.responses))) {
    if (!status.startsWith('2') || !(status in nRes)) continue;
    const os = obj(obj(obj(res).content)['application/json']).schema;
    const ns = obj(obj(obj(nRes[status]).content)['application/json']).schema;
    if (os && ns) added(a, b, os, ns, 'response', status, out);
  }
  if (!oldOp.deprecated && newOp.deprecated) out.push({ class: 'notable', text: 'deprecated' });
  return out;
}

/** Every change from `prev` to `next`, safe and breaking, each tied to an operation. */
export function changes(prev: Doc, next: Doc): Change[] {
  const out: Change[] = [];
  const idOf = (doc: Doc, path: string, method: string) =>
    String(obj(obj(doc.paths?.[path])[method]).operationId ?? '');
  for (const [path, item] of Object.entries(next.paths ?? {}))
    for (const method of METHODS) {
      const newOp = obj(obj(item)[method]);
      if (!Object.keys(newOp).length) continue;
      const op = `${method.toUpperCase()} ${path}`;
      const operationId = idOf(next, path, method);
      const oldOp = obj(obj(prev.paths?.[path])[method]);
      if (!Object.keys(oldOp).length)
        out.push({ operationId, op, class: 'additive', text: 'new operation' });
      else
        for (const c of addedInOperation(prev, next, oldOp, newOp))
          out.push({ operationId, op, ...c });
    }
  for (const text of breakingChanges(prev, next)) {
    const op = /^([A-Z]+ \S+?)(?::| |$)/.exec(text)?.[1] ?? '';
    const [method = '', path = ''] = op.split(' ');
    out.push({
      operationId: idOf(prev, path, method.toLowerCase()),
      op,
      class: 'breaking',
      text: text.slice(op.length).replace(/^:? ?/, '') || 'changed',
    });
  }
  return out;
}

/** The schema a change's `where` path names in an operation: `200.items[].key`, `body.x|1.y`, `param query:n`. */
function schemaAt(doc: Doc, op: Json, where: string): Json | null {
  const head = /^(body|param \S+|\d{3})/.exec(where)?.[1];
  if (!head) return null;
  let node: unknown;
  if (head === 'body') node = obj(obj(obj(op.requestBody).content)['application/json']).schema;
  else if (head.startsWith('param ')) node = paramMap(doc, op).get(head.slice(6))?.schema;
  else node = obj(obj(obj(obj(op.responses)[head]).content)['application/json']).schema;
  let cur = deref(doc, node);
  for (const [, name, index] of where.slice(head.length).matchAll(/\.([^.[|]+)|\[\]|\|(\d+)/g)) {
    const next =
      name !== undefined
        ? obj(cur.properties)[name]
        : index !== undefined
          ? (['anyOf', 'oneOf', 'allOf'] as const).flatMap((k) =>
              Array.isArray(cur[k]) ? [cur[k]] : [],
            )[0]?.[Number(index)]
          : cur.items;
    if (next === undefined) return null;
    cur = deref(doc, next);
  }
  return cur;
}

/**
 * Whether what an "added" or "removed" change says still holds in `doc`: the operation, field or enum
 * value is there (or, for a removal, gone). False marks a pending entry the spec has since left behind;
 * a change this cannot read counts as holding.
 */
export function changeHolds(doc: Doc, op: string, text: string): boolean {
  // Webhook entries ('webhook pass.voided') have no path to look up.
  if (!/^[A-Z]+ \//.test(op)) return true;
  const [method = '', path = ''] = op.split(' ');
  const here = obj(obj(doc.paths?.[path])[method.toLowerCase()]);
  const present = Object.keys(here).length > 0;
  if (text === 'operation removed') return !present;
  if (!present) return false;
  if (text === 'new operation') return true;
  const field = /^(.+)\.([^.[|]+): (?:optional input )?field added$/.exec(text);
  if (field) {
    const parent = schemaAt(doc, here, field[1] as string);
    return parent === null || (field[2] as string) in obj(parent.properties);
  }
  const value = /^(.+): enum value (.+) added$/.exec(text);
  if (value) {
    const node = schemaAt(doc, here, value[1] as string);
    return (
      node === null ||
      !Array.isArray(node.enum) ||
      node.enum.includes(JSON.parse(value[2] as string))
    );
  }
  return true;
}
