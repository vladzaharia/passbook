import { pathValue } from './ids.ts';
import type { Json, OpView } from './types.ts';

/** The JSON body to send, when the operation takes one. */
export function bodyOf(op: OpView): Json | undefined {
  return op.method === 'get' || op.binary ? undefined : op.sample.body;
}
/** The query to send: what the call needs, and a page size where the operation takes one. */
export function queryOf(op: OpView): Record<string, Json> {
  const limit = op.paged && op.fields.some((f) => f.where === 'query' && f.name === 'limit');
  return { ...op.sample.query, ...(limit ? { limit: 25 } : {}) };
}

/** A TypeScript literal for a JSON value: bare keys, single quotes. */
function value(v: Json, pad = ''): string {
  if (v === null || typeof v !== 'object')
    return typeof v === 'string'
      ? `'${v.replaceAll('\\', '\\\\').replaceAll("'", "\\'")}'`
      : String(v);
  const inner = `${pad}  `;
  if (Array.isArray(v))
    return v.length === 0
      ? '[]'
      : `[\n${v.map((x) => inner + value(x, inner)).join(',\n')},\n${pad}]`;
  const entries = Object.entries(v);
  if (entries.length === 0) return '{}';
  const key = (k: string) => (/^[A-Za-z_$][\w$]*$/.test(k) ? k : `'${k}'`);
  return `{\n${entries.map(([k, x]) => `${inner}${key(k)}: ${value(x, inner)}`).join(',\n')},\n${pad}}`;
}

/**
 * One call through @passbook/sdk, as `pb.<resource>.<method>(...)`: path ids first, then the body
 * (or a page size for a list), as the SDK's resources take them. Paged lists walk every page.
 */
export function tsSample(op: OpView): string {
  const type = (name: string) => op.fields.find((f) => f.where === 'path' && f.name === name)?.type;
  const args = [...op.path.matchAll(/\{(\w+)\}/g)].map((m) => {
    const t = type(m[1] ?? '') ?? 'string';
    const v = pathValue(op.path, m[1] ?? '', t);
    return /^(integer|number)/.test(t) ? v : `'${v}'`;
  });
  const body = bodyOf(op);
  if (op.binary) args.push("await readFile('image.png')");
  else if (body !== undefined) args.push(value(body));
  const query = queryOf(op);
  const hasQuery = Object.keys(query).length > 0;
  const hasHeaders = Object.keys(op.sample.headers).length > 0;
  // A GET takes its query where a write takes its body; a write's query rides in the options.
  const primary = op.binary || body !== undefined;
  if (!primary && (hasQuery || (hasHeaders && op.fields.some((f) => f.where === 'query'))))
    args.push(hasQuery ? value(query) : 'undefined');
  const options = [
    ...(primary && hasQuery ? [`query: ${value(query, '  ')}`] : []),
    ...(hasHeaders ? [`headers: ${value(op.sample.headers, '  ')}`] : []),
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
