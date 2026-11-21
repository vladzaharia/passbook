// The SDK's view of docs/api/openapi.v1.json: which operations it exposes and how each is called.
import { type Schema, tsType } from './sdk-ts-schema.ts';

interface Param {
  name: string;
  in: string;
  required?: boolean;
  schema: Schema;
  'x-platform-only'?: boolean;
}
interface Operation {
  operationId: string;
  summary?: string;
  parameters?: Array<Param | { $ref: string }>;
  requestBody?: { required?: boolean; content: Record<string, { schema: Schema }> };
  responses: Record<string, { content?: Record<string, { schema: Schema }> }>;
  security?: Array<Record<string, unknown>>;
  'x-sdk'?: { resource: string; method: string };
}
export interface OpenApiDoc {
  paths: Record<string, Record<string, Operation | unknown>>;
  components: { schemas: Record<string, Schema>; parameters?: Record<string, Param> };
}
export type SdkNames = Record<string, { resource: string; method: string; sdk?: boolean }>;

export interface SdkOp {
  id: string;
  resource: string[];
  method: string;
  http: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
  path: string;
  summary: string;
  pathParams: Array<{ name: string; type: string }>;
  /** Type text of the query object, absent when the operation takes none. */
  query?: { type: string; required: boolean };
  body?: { type: string; required: boolean };
  /** A raw upload the document does not describe: the content type to send. */
  binary?: string;
  /** Type text of the success body; `Response` for a download, `void` for no content. */
  result: string;
  raw: boolean;
  idempotent: boolean;
  /** The query parameter that carries the next page's cursor. */
  cursor?: string;
  typeName: string;
}

const METHODS = ['get', 'post', 'put', 'patch', 'delete'] as const;
const IDEMPOTENCY_HEADER = 'Idempotency-Key';
const pascal = (text: string): string =>
  text.replace(/(^|[^A-Za-z0-9]+)([A-Za-z0-9])/g, (_, __, c) => c.toUpperCase());

const refName = (ref: string): string => ref.slice(ref.lastIndexOf('/') + 1);

function resolveSchema(doc: OpenApiDoc, s: Schema): Schema {
  let cur = s;
  while (cur.$ref) cur = doc.components.schemas[refName(cur.$ref)] ?? {};
  return cur;
}

/** The next-page cursor parameter, when the operation returns `items` and `nextCursor`. */
function cursorParam(
  doc: OpenApiDoc,
  http: string,
  params: Param[],
  ok?: Schema,
): string | undefined {
  if (http !== 'GET' || !ok) return undefined;
  const pages = resolveSchema(doc, ok).anyOf ?? [ok];
  const paged = pages.every((p) => {
    const props = resolveSchema(doc, p).properties ?? {};
    return 'items' in props && 'nextCursor' in props;
  });
  return paged ? ['cursor', 'after'].find((n) => params.some((p) => p.name === n)) : undefined;
}

function operationOf(doc: OpenApiDoc, path: string, http: string, op: Operation): SdkOp {
  const name = op['x-sdk'];
  if (!name) throw new Error(`${op.operationId} has no x-sdk`);
  const params = (op.parameters ?? []).map((p) =>
    '$ref' in p ? (doc.components.parameters?.[refName(p.$ref)] as Param) : p,
  );
  const typeName = pascal(`${name.resource} ${name.method}`);
  const idempotent = params.some((p) => p.in === 'header' && p.name === IDEMPOTENCY_HEADER);
  for (const p of params)
    if (p.in === 'header' && p.name !== IDEMPOTENCY_HEADER)
      throw new Error(`${op.operationId}: header parameter ${p.name} is not supported`);

  const byName = new Map(params.filter((p) => p.in === 'path').map((p) => [p.name, p]));
  const pathParams = [...path.matchAll(/\{(\w+)\}/g)].map((m) => {
    const p = byName.get(m[1] ?? '');
    if (!p) throw new Error(`${op.operationId}: path parameter ${m[1]} is not declared`);
    return { name: p.name, type: tsType(p.schema).replace(/ \| null/g, '') };
  });

  const queryParams = params.filter((p) => p.in === 'query' && !p['x-platform-only']);
  const query = queryParams.length
    ? {
        type: tsType({
          type: 'object',
          properties: Object.fromEntries(queryParams.map((p) => [p.name, p.schema])),
          required: queryParams.filter((p) => p.required).map((p) => p.name),
        }),
        required: queryParams.some((p) => p.required),
      }
    : undefined;

  const bodyContent = op.requestBody?.content;
  if (bodyContent && Object.keys(bodyContent).some((t) => t !== 'application/json'))
    throw new Error(`${op.operationId}: only JSON request bodies are supported`);
  const bodySchema = bodyContent?.['application/json']?.schema;

  const success = Object.keys(op.responses)
    .filter((c) => /^2\d\d$/.test(c))
    .sort()[0];
  const okSchema = success
    ? op.responses[success]?.content?.['application/json']?.schema
    : undefined;
  const raw = !okSchema && http === 'get';
  const binary = !bodySchema && name.method === 'upload' && http !== 'get';
  const cursor = cursorParam(doc, http.toUpperCase(), queryParams, okSchema);

  return {
    id: op.operationId,
    resource: name.resource.split('.'),
    method: name.method,
    http: http.toUpperCase() as SdkOp['http'],
    path,
    summary: (op.summary ?? '').replace(/\*\//g, '* /').trim(),
    pathParams,
    ...(query ? { query } : {}),
    ...(bodySchema
      ? { body: { type: tsType(bodySchema), required: op.requestBody?.required === true } }
      : {}),
    ...(binary
      ? { binary: /\bPNG\b/.test(op.summary ?? '') ? 'image/png' : 'application/octet-stream' }
      : {}),
    result: okSchema ? tsType(okSchema) : raw ? 'Response' : 'void',
    raw,
    idempotent,
    ...(cursor ? { cursor } : {}),
    typeName,
  };
}

/** Operations the SDK exposes, in a stable order: sdk !== false, keys accepted, named as in sdk-names.json. */
export function sdkOperations(doc: OpenApiDoc, names: SdkNames): SdkOp[] {
  const out: SdkOp[] = [];
  const seen = new Set<string>();
  for (const [path, item] of Object.entries(doc.paths).sort(([a], [b]) => (a < b ? -1 : 1))) {
    for (const http of METHODS) {
      const op = item[http] as Operation | undefined;
      if (!op) continue;
      const frozen = names[op.operationId];
      if (!frozen) throw new Error(`${op.operationId} is missing from docs/api/sdk-names.json`);
      const accepted = (op.security ?? []).some((s) => 'apiKey' in s);
      if (frozen.sdk === false || !accepted) continue;
      if (op['x-sdk']?.resource !== frozen.resource || op['x-sdk']?.method !== frozen.method)
        throw new Error(`${op.operationId}: x-sdk differs from docs/api/sdk-names.json`);
      const sdkOp = operationOf(doc, path, http, op);
      const unique = `${sdkOp.resource.join('.')}#${sdkOp.method}`;
      if (seen.has(unique)) throw new Error(`Two operations are named ${unique}`);
      seen.add(unique);
      out.push(sdkOp);
    }
  }
  return out;
}
