import { cliSample } from '../../developers/model/cli.ts';
import type { Lang } from '../../developers/model/highlight.ts';
import { type Sample, samplesFor } from '../../developers/model/samples.ts';
import type { Json as ModelJson, OpView } from '../../developers/model/types.ts';
import { type Draft, parseBody } from './request.ts';
import type { Json, RunOp } from './types.ts';

/** One way to say the request: curl, each language's SDK call (plain HTTP until it is published), the CLI. */
export interface Line {
  lang: Lang;
  label: string;
  /** The SDK is not published yet: the line is plain HTTP and the tab says so. */
  soon: boolean;
  code: string;
}

const ORDER: Lang[] = ['curl', 'ts', 'py', 'go', 'cli'];

const asNumber = (op: RunOp, name: string, value: string): Json => {
  const type = op.params.find((p) => p.where === 'query' && p.name === name)?.schema.type;
  const t = Array.isArray(type) ? type[0] : type;
  if ((t === 'integer' || t === 'number') && value !== '' && !Number.isNaN(Number(value)))
    return Number(value);
  return t === 'boolean' && (value === 'true' || value === 'false') ? value === 'true' : value;
};

/**
 * The request as the SDK, the CLI, curl and plain HTTP write it, from what the form holds now. The
 * docs' own writers (developers/model/samples.ts), so a line here reads like the reference's. The
 * key is `$PASSBOOK_KEY` in all of them: the Workbench token is never in any line.
 */
export function linesFor(op: RunOp, draft: Draft, origin: string): Line[] {
  const body = parseBody(draft.body);
  const query: Record<string, Json> = {};
  for (const [k, v] of Object.entries(draft.query)) if (v !== '') query[k] = asNumber(op, k, v);
  // The bearer is the key's place, never a typed value: whatever carries one is left out.
  const headers = Object.fromEntries(
    Object.entries(draft.header).filter(
      ([k, v]) => v !== '' && !/^(authorization|cookie)$/i.test(k),
    ),
  );
  const ids = Object.fromEntries(Object.entries(draft.path).filter(([, v]) => v !== ''));
  const source = {
    method: op.method,
    path: op.path,
    idempotent: op.idempotent && draft.idemOn,
    fields: op.params.map((p) => ({
      name: p.name,
      where: p.where,
      type: (Array.isArray(p.schema.type) ? p.schema.type[0] : p.schema.type) ?? 'string',
      required: p.required,
      deprecated: false,
      children: [],
      description: p.description,
    })),
    sample: {
      body: op.body && body.ok ? (body.value as ModelJson | undefined) : undefined,
      query: query as Record<string, ModelJson>,
      headers,
    },
    binary: Boolean(op.sdk.binary),
    download: Boolean(op.sdk.download),
    paged: Boolean(op.sdk.paged),
    noContent: Boolean(op.sdk.noContent),
    cursorList: Boolean(op.sdk.cursorList),
    sdkCall: op.sdk.call,
    ids,
  } satisfies Pick<OpView, 'method' | 'path' | 'idempotent' | 'fields' | 'sample'> &
    Record<string, unknown>;
  const all: Sample[] = [...samplesFor(source, origin), ...cliSample(source)];
  return ORDER.flatMap((lang) => {
    const s = all.find((x) => x.lang === lang);
    return s ? [{ lang, label: s.label, soon: s.soon === true, code: s.code }] : [];
  });
}
