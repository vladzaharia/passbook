import { tsLiteral, tsString } from './code-literals.ts';
import { pathValue } from './ids.ts';
import type { Json, OpView } from './types.ts';

/** What a sample is written from; the playground builds one without a page. */
export type SampleOp = Pick<
  OpView,
  | 'method'
  | 'path'
  | 'idempotent'
  | 'fields'
  | 'sample'
  | 'binary'
  | 'download'
  | 'paged'
  | 'sdkCall'
> &
  Partial<Pick<OpView, 'noContent' | 'cursorList'>> & {
    /** Path values to write in place of the example ids (the console's own). */
    ids?: Record<string, string>;
  };

/** The value a sample writes for `{name}`: the caller's own, else the example id. */
export const idFor = (
  op: Pick<SampleOp, 'ids'>,
  path: string,
  name: string,
  type: string,
): string => op.ids?.[name] || pathValue(path, name, type);

/** The JSON body to send, when the operation takes one. */
export function bodyOf(op: SampleOp): Json | undefined {
  return op.method === 'get' || op.binary ? undefined : op.sample.body;
}
/** The query to send: what the call needs, and a page size where the operation takes one. */
export function queryOf(op: SampleOp): Record<string, Json> {
  const field = op.paged
    ? op.fields.find((f) => f.where === 'query' && f.name === 'limit')
    : undefined;
  // 25, or the route's own maximum when it is lower (the type label carries it as `≤ N`).
  const max = Number(field?.type.match(/≤ (\d+)/)?.[1] ?? 25);
  return { ...op.sample.query, ...(field ? { limit: Math.min(25, max) } : {}) };
}

/**
 * One call through @passbook/sdk, as `pb.<resource>.<method>(...)`: path ids first, then the body
 * (or a page size for a list), as the SDK's resources take them. Paged lists walk every page.
 */
export function tsSample(op: SampleOp): string {
  const type = (name: string) => op.fields.find((f) => f.where === 'path' && f.name === name)?.type;
  const args = [...op.path.matchAll(/\{(\w+)\}/g)].map((m) => {
    const t = type(m[1] ?? '') ?? 'string';
    const v = idFor(op, op.path, m[1] ?? '', t);
    return /^(integer|number)/.test(t) ? v : tsString(v);
  });
  const body = bodyOf(op);
  if (op.binary) args.push("await readFile('image.png')");
  else if (body !== undefined) args.push(tsLiteral(body));
  const query = queryOf(op);
  const hasQuery = Object.keys(query).length > 0;
  const hasHeaders = Object.keys(op.sample.headers).length > 0;
  // A GET takes its query where a write takes its body; a write's query rides in the options.
  const primary = op.binary || body !== undefined;
  if (!primary && (hasQuery || (hasHeaders && op.fields.some((f) => f.where === 'query'))))
    args.push(hasQuery ? tsLiteral(query) : 'undefined');
  const options = [
    ...(primary && hasQuery ? [`query: ${tsLiteral(query, '  ')}`] : []),
    ...(hasHeaders ? [`headers: ${tsLiteral(op.sample.headers, '  ')}`] : []),
  ];
  if (options.length > 0) args.push(`{ ${options.join(', ')} }`);
  const call = `pb.${op.sdkCall.slice(3)}(${args.join(', ')})`;
  const use = op.paged
    ? [`for await (const item of ${call}) console.log(item);`]
    : op.download
      ? [`await ${call};`]
      : [`const result = await ${call};`, 'console.log(result);'];
  return [
    ...(op.binary ? ["import { readFile } from 'node:fs/promises';"] : []),
    "import { PassBook } from '@passbook/sdk';",
    '',
    "const pb = new PassBook({ apiKey: process.env.PASSBOOK_KEY ?? '' });",
    '',
    ...use,
  ].join('\n');
}
