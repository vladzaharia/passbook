// Breaking-change rules for the committed OpenAPI document. Pure: no I/O.
type Json = Record<string, unknown>;
export type Doc = { paths?: Record<string, Record<string, unknown>>; components?: Json } & Json;

const METHODS = ['get', 'post', 'put', 'patch', 'delete'];
const obj = (v: unknown): Json => (v && typeof v === 'object' ? (v as Json) : {});

function deref(doc: Doc, node: unknown): Json {
  let cur = obj(node);
  for (let i = 0; i < 20 && typeof cur.$ref === 'string'; i++) {
    const target = (cur.$ref as string)
      .replace(/^#\//, '')
      .split('/')
      .reduce<unknown>((acc, k) => obj(acc)[k], doc);
    cur = obj(target);
  }
  return cur;
}

type Side = 'request' | 'response';

/** Response: a removed field or enum value breaks. Request: a new required field or a removed enum value does. */
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
