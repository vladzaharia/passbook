import { prefillFromCurl } from '../../developers/guide/model.ts';
import { refName, resolve } from '../../developers/model/schema.ts';
import type {
  Dict,
  Json,
  Method,
  OpView,
  RawDoc,
  RawOp,
  Site,
} from '../../developers/model/types.ts';
import {
  RUN_DIR,
  type RunFile,
  type RunIndex,
  type RunOp,
  type RunParam,
  type RunSample,
  type RunSchema,
  type RunSdk,
} from './types.ts';

const asDict = (v: unknown): Dict => (v && typeof v === 'object' ? (v as Dict) : {});
const KEEP = [
  'type',
  'required',
  'enum',
  'format',
  'minimum',
  'maximum',
  'minLength',
  'maxLength',
  'pattern',
  'minItems',
  'maxItems',
  'nullable',
] as const;
const MAX_DEPTH = 6;
/** Standard headers the console sets itself. */
const OWN_HEADERS = new Set(['idempotency-key', 'authorization', 'content-type', 'accept']);
/** Bulk runs act on every pass a filter matches: they ask twice like a delete. */
const BULK = /\/bulk-runs(\/|$)/;
const DESTRUCTIVE = /(^|[/.])(void|remove|revoke|purge|close|reset|delete)([/.]|$)/;

/** The schema without `$ref`s, composition resolved, platform-only fields gone and depth capped. */
export function slim(doc: RawDoc, node: unknown, depth = 0, seen: string[] = []): RunSchema {
  const name = refName(node);
  if (name && seen.includes(name)) return {};
  const trail = name ? [...seen, name] : seen;
  const s = resolve(doc, node);
  const out: Record<string, unknown> = {};
  for (const k of KEEP) if (s[k] !== undefined) out[k] = s[k];
  if (typeof s.description === 'string') out.description = s.description.slice(0, 200);
  const props = { ...asDict(s.properties) };
  const required = new Set<string>(Array.isArray(s.required) ? (s.required as string[]) : []);
  for (const part of Array.isArray(s.allOf) ? s.allOf : []) {
    const p = slim(doc, part, depth, trail);
    Object.assign(props, p.properties ?? {});
    for (const r of p.required ?? []) required.add(r);
    if (p.type && !out.type) out.type = p.type;
  }
  if (depth >= MAX_DEPTH) return out as RunSchema;
  const entries = Object.entries(props).filter(([, v]) => !resolve(doc, v)['x-platform-only']);
  if (entries.length > 0) {
    out.properties = Object.fromEntries(
      entries.map(([k, v]) => [k, slim(doc, v, depth + 1, trail)]),
    );
    out.type ??= 'object';
  }
  if (required.size > 0) out.required = [...required];
  if (s.items) out.items = slim(doc, s.items, depth + 1, trail);
  for (const alt of ['oneOf', 'anyOf'] as const)
    if (Array.isArray(s[alt]))
      out[alt] = (s[alt] as unknown[]).slice(0, 8).map((a) => slim(doc, a, depth + 1, trail));
  return out as RunSchema;
}

function params(doc: RawDoc, op: RawOp): RunParam[] {
  const rows: RunParam[] = [];
  for (const raw of op.parameters ?? []) {
    const p = resolve(doc, raw);
    const where = p.in as RunParam['where'];
    if (p['x-platform-only'] || (where !== 'path' && where !== 'query' && where !== 'header'))
      continue;
    if (where === 'header' && OWN_HEADERS.has(String(p.name).toLowerCase())) continue;
    rows.push({
      name: String(p.name),
      where,
      required: p.required === true || where === 'path',
      schema: slim(doc, p.schema),
      description: typeof p.description === 'string' ? p.description.slice(0, 200) : '',
    });
  }
  // The document names If-Match in the summary, not as a parameter.
  if (/If-Match/.test(op.summary ?? '') && !rows.some((r) => r.name.toLowerCase() === 'if-match'))
    rows.push({
      name: 'If-Match',
      where: 'header',
      required: true,
      schema: { type: 'string' },
      description: 'The version you last read.',
    });
  return rows.sort((a, b) => Number(b.required) - Number(a.required));
}

/** The guides' snippets that call this operation, with the body and query each one sends. */
function samples(view: Omit<OpView, 'run'>): Record<string, RunSample> | undefined {
  const out: Record<string, RunSample> = {};
  for (const e of view.examples ?? []) {
    if (!e.curl) continue;
    try {
      out[e.id] = prefillFromCurl(e.curl, e.id);
    } catch {
      // A snippet that is not a plain curl call has nothing to open the console with.
    }
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

function sdkOf(view: Omit<OpView, 'run'>): RunSdk {
  return {
    call: view.sdkCall,
    ...(view.paged ? { paged: true as const } : {}),
    ...(view.cursorList ? { cursorList: true as const } : {}),
    ...(view.noContent ? { noContent: true as const } : {}),
    ...(view.binary ? { binary: true as const } : {}),
    ...(view.download ? { download: true as const } : {}),
  };
}

export function runOp(doc: RawDoc, view: Omit<OpView, 'run'>, op: RawOp, method: Method): RunOp {
  const body = asDict(asDict(asDict(op.requestBody).content)['application/json']);
  const sdk = op['x-sdk'];
  const snippets = samples(view);
  return {
    id: op.operationId,
    anchor: view.anchor,
    title: view.title,
    method,
    path: view.path,
    idempotent: view.idempotent,
    destructive:
      method === 'delete' ||
      DESTRUCTIVE.test(`${sdk?.method ?? ''}`) ||
      DESTRUCTIVE.test(view.path) ||
      (method === 'post' && BULK.test(view.path)),
    params: params(doc, op),
    body: body.schema ? slim(doc, body.schema) : null,
    example: view.requestExample as Json | undefined,
    wb: op['x-workbench'] === 'test',
    sdk: sdkOf(view),
    ...(snippets ? { samples: snippets } : {}),
  };
}

export function runFile(origin: string, ops: RunOp[]): RunFile {
  return { origin, ops };
}

export function runIndex(site: Site): RunIndex {
  return {
    groups: site.groups.map((g) => ({
      label: g.label,
      items: g.pages.flatMap((p) =>
        p.ops.map((o) => ({
          id: o.operationId,
          slug: p.slug,
          anchor: o.anchor,
          method: o.method,
          path: o.path,
          title: o.title,
          destructive: o.run.destructive,
          wb: o.run.wb,
        })),
      ),
    })),
    codes: site.errors.map((e) => e.code),
  };
}

export const runFileUrl = (slug: string) => `${RUN_DIR}/${slug}.json`;
