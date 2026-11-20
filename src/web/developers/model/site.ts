import { minimalExample } from './example.ts';
import { GROUP_ORDER, groupOf, labelOf, slugOf } from './resources.ts';
import { bodyFields, paramFields, refName, resolve } from './schema.ts';
import {
  type ChangeEntry,
  type ConsoleOp,
  type Dict,
  type ErrorEntry,
  type ErrorRow,
  type Example,
  type Json,
  METHODS,
  type Method,
  type OpView,
  type ProtocolOp,
  type RawDoc,
  type RawOp,
  type ReferenceEntry,
  type ResourcePage,
  type Site,
  type WebhookEvent,
} from './types.ts';

export interface Inputs {
  doc: RawDoc;
  reference: Record<string, ReferenceEntry>;
  changelog: ChangeEntry[];
  /** docs/api/errors.json (PX4): `[{code,status}]` or `{code: {status}}`. Absent until PX4. */
  errors?: unknown;
  /** docs/api/error-guide.json (PX4): `{code: {title,when,fix,retryable}}`. */
  guide?: Record<string, Dict>;
  /** docs/developers/snippets/guides: the hand-written snippets. */
  examples?: Example[];
}

const asDict = (v: unknown): Dict => (v && typeof v === 'object' ? (v as Dict) : {});
const accepts = (op: RawOp, scheme: string) => (op.security ?? []).some((s) => scheme in s);

/** The operations an API key may call, without the platform's own. */
export const isPublished = (op: RawOp) =>
  accepts(op, 'apiKey') &&
  op['x-sdk'] !== undefined &&
  op['x-sdk'].sdk !== false &&
  !op['x-sdk'].resource.startsWith('platform');

const isConsoleOnly = (op: RawOp) =>
  accepts(op, 'session') &&
  !accepts(op, 'apiKey') &&
  op['x-sdk'] !== undefined &&
  op['x-sdk'].sdk !== false &&
  !op['x-sdk'].resource.startsWith('platform');

/** Status and code rows from the PX4 catalog, whichever of the two shapes it takes. */
function statusByCode(errors: unknown): Map<string, number> {
  const out = new Map<string, number>();
  const rows: Dict[] = Array.isArray(errors)
    ? errors.map((e) => asDict(e))
    : Object.entries(asDict(errors)).map(([code, e]) => ({ code, ...asDict(e) }));
  for (const r of rows)
    if (typeof r.code === 'string' && typeof r.status === 'number') out.set(r.code, r.status);
  return out;
}

function errorRows(
  op: RawOp,
  status: Map<string, number>,
  guide: Record<string, Dict>,
): ErrorRow[] {
  const raw = op['x-codes'];
  if (!Array.isArray(raw)) return [];
  return raw.flatMap((c): ErrorRow[] => {
    const e = typeof c === 'string' ? { code: c } : asDict(c);
    if (typeof e.code !== 'string') return [];
    const fix = e.fix ?? guide[e.code]?.fix;
    return [
      {
        code: e.code,
        status: typeof e.status === 'number' ? e.status : (status.get(e.code) ?? null),
        fix: typeof fix === 'string' ? fix : '',
      },
    ];
  });
}

/** Examples show the sandbox: `mode` reads "test" wherever the contract's example says "live". */
function testMode(value: Json | undefined): Json | undefined {
  if (Array.isArray(value)) return value.map((v) => testMode(v) as Json);
  if (value === null || typeof value !== 'object') return value;
  return Object.fromEntries(
    Object.entries(value).map(([k, v]) => [k, k === 'mode' && v === 'live' ? 'test' : testMode(v)]),
  ) as Json;
}

const exampleOf = (content: Dict | undefined): Json | undefined =>
  testMode(asDict(asDict(content)['application/json']).example as Json | undefined);

/** The query parameters a call cannot leave out, as example values. */
function requiredQuery(doc: RawDoc, params: Dict[] | undefined): Record<string, Json> {
  const out: Record<string, Json> = {};
  for (const raw of params ?? []) {
    const p = resolve(doc, raw);
    if (p.in === 'query' && p.required === true && !p['x-platform-only'])
      out[String(p.name)] = minimalExample(doc, p.schema, String(p.name));
  }
  return out;
}

const isPaged = (example: Json | undefined): boolean =>
  example !== null &&
  typeof example === 'object' &&
  !Array.isArray(example) &&
  'items' in example &&
  'nextCursor' in example;

function view(
  doc: RawDoc,
  path: string,
  method: Method,
  op: RawOp,
  inputs: Inputs,
  status: Map<string, number>,
): OpView {
  const ref = inputs.reference[op.operationId];
  const sdk = op['x-sdk'] as NonNullable<RawOp['x-sdk']>;
  const [, ...subs] = sdk.resource.split('.');
  const sub = subs.length > 0 ? subs.join('-') : null;
  const body = asDict(asDict(op.requestBody).content)['application/json'];
  const ok = Object.entries(op.responses ?? {}).find(([code]) => code.startsWith('2'));
  const okSchema = ok
    ? asDict(asDict(asDict(ok[1]).content)['application/json']).schema
    : undefined;
  const summary = op.summary ?? op.operationId;
  const returnsExample = ok
    ? (exampleOf(asDict(ok[1]).content as Dict) ?? testMode(ref?.response))
    : undefined;
  const requestExample = testMode((asDict(body).example as Json | undefined) ?? ref?.request);
  const scopes = [...new Set((op.security ?? []).flatMap((s) => s.apiKey ?? []))];
  const idempotent = /Idempotency-Key/.test(summary);
  return {
    anchor: sub ? `${sub}-${sdk.method}` : sdk.method,
    operationId: op.operationId,
    method,
    path,
    title: summary.replace(/\s*\([^)]*\)\s*$/, ''),
    idempotent,
    description: op.description ?? ref?.description ?? '',
    scopes,
    sdkCall: `pb.${sdk.resource}.${sdk.method}`,
    fields: [
      ...paramFields(doc, op.parameters),
      ...(body ? bodyFields(doc, asDict(body).schema) : []),
    ],
    requestExample,
    examples: (inputs.examples ?? []).filter((e) => e.ops.includes(op.operationId)),
    sample: {
      body:
        ref?.snippet?.request ??
        (asDict(op.requestBody).required === true && body && requestExample === undefined
          ? minimalExample(doc, asDict(body).schema)
          : requestExample),
      query: { ...requiredQuery(doc, op.parameters), ...ref?.snippet?.query },
      headers: ref?.snippet?.headers ?? {},
    },
    returns: ok
      ? {
          status: ok[0],
          schema:
            refName(okSchema) ?? (okSchema ? (refName(resolve(doc, okSchema)) ?? null) : null),
          example: returnsExample,
        }
      : null,
    errors: errorRows(op, status, inputs.guide ?? {}),
    deprecated: op.deprecated === true,
    sub,
    paged: method === 'get' && isPaged(returnsExample),
    binary: !body && sdk.method === 'upload' && method !== 'get',
    download: method === 'get' && !okSchema,
  };
}

function webhookEvents(doc: RawDoc): WebhookEvent[] {
  return Object.entries(doc.webhooks ?? {}).map(([type, item]) => ({
    type,
    summary: String(asDict(item.post).summary ?? ''),
  }));
}

export function buildSite(inputs: Inputs): Site {
  const { doc } = inputs;
  const status = statusByCode(inputs.errors);
  const pages = new Map<string, ResourcePage>();
  const consoleOps = new Map<string, ConsoleOp[]>();
  const protocols: ProtocolOp[] = [];
  let opCount = 0;
  const entries = Object.entries(doc.paths).flatMap(([path, item]) =>
    METHODS.flatMap((m) =>
      item[m]?.operationId ? [{ path, method: m, op: item[m] as RawOp }] : [],
    ),
  );
  for (const { path, method, op } of entries) {
    const sdk = op['x-sdk'];
    if (!sdk) continue;
    const top = sdk.resource.split('.')[0] ?? sdk.resource;
    if (isPublished(op)) {
      const page = pages.get(top) ?? {
        key: top,
        slug: slugOf(top),
        label: labelOf(top),
        group: groupOf(top),
        ops: [],
        consoleOnly: [],
      };
      page.ops.push(view(doc, path, method, op, inputs, status));
      pages.set(top, page);
      opCount += 1;
    } else if (isConsoleOnly(op)) {
      const list = consoleOps.get(top) ?? [];
      list.push({ method, path, title: op.summary ?? op.operationId });
      consoleOps.set(top, list);
    } else if (
      sdk.sdk === false &&
      /^(apple|public|terminal|googleWallet|samsungWallet)/.test(sdk.resource)
    ) {
      protocols.push({
        method,
        path,
        title: op.summary ?? op.operationId,
        reason: sdk.reason ?? '',
      });
    }
  }
  const sorted = [...pages.values()].sort((a, b) => a.label.localeCompare(b.label));
  for (const page of sorted) {
    page.consoleOnly = consoleOps.get(page.key) ?? [];
    // The resource's own operations first, then each sub-resource; the document's order within.
    page.ops = page.ops
      .map((op, i) => ({ op, i }))
      .sort((a, b) => (a.op.sub ?? '').localeCompare(b.op.sub ?? '') || a.i - b.i)
      .map((x) => x.op);
  }
  const order = [...new Set(sorted.map((p) => p.group))];
  const groups = orderGroups(order).map((label) => ({
    label,
    pages: sorted.filter((p) => p.group === label),
  }));
  return {
    baseUrl: doc.servers?.[0]?.url ?? '',
    version: doc.info.version,
    groups,
    pages: sorted,
    protocols,
    webhookEvents: webhookEvents(doc),
    changelog: inputs.changelog,
    errors: errorEntries(sorted, status, inputs),
    opCount,
  };
}

const orderGroups = (labels: string[]) =>
  [...labels].sort(
    (a, b) =>
      GROUP_ORDER.indexOf(a as (typeof GROUP_ORDER)[number]) -
      GROUP_ORDER.indexOf(b as (typeof GROUP_ORDER)[number]),
  );

function errorEntries(
  pages: ResourcePage[],
  status: Map<string, number>,
  inputs: Inputs,
): ErrorEntry[] {
  const used = new Map<string, ErrorEntry['usedBy']>();
  for (const p of pages)
    for (const op of p.ops)
      for (const e of op.errors)
        used.set(e.code, [
          ...(used.get(e.code) ?? []),
          { slug: p.slug, anchor: op.anchor, title: op.title },
        ]);
  const codes = new Set([...used.keys(), ...status.keys()]);
  return [...codes].sort().map((code) => {
    const g = inputs.guide?.[code] ?? {};
    return {
      code,
      status: status.get(code) ?? null,
      title: typeof g.title === 'string' ? g.title : code,
      when: typeof g.when === 'string' ? g.when : '',
      fix: typeof g.fix === 'string' ? g.fix : '',
      retryable: typeof g.retryable === 'boolean' ? g.retryable : null,
      usedBy: used.get(code) ?? [],
    };
  });
}
