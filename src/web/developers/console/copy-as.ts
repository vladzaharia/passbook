import type { Lang } from '../model/highlight.ts';
import { pyValue, tsValue } from '../model/samples.ts';
import type { Json } from './types.ts';

/** The request the console sent, with the key left out: Copy as writes `$PASSBOOK_KEY` in its place. */
export interface Sent {
  method: string;
  url: string;
  headers: [string, string][];
  body?: Json;
}

export const COPY_LANGS = [
  { lang: 'ts', label: 'TypeScript' },
  { lang: 'curl', label: 'curl' },
  { lang: 'py', label: 'Python' },
  { lang: 'go', label: 'Go' },
] as const satisfies { lang: Lang; label: string }[];
export type CopyLang = (typeof COPY_LANGS)[number]['lang'];

const KEY = 'PASSBOOK_KEY';
const json = (v: Json) => JSON.stringify(v, null, 2);
const withBody = (s: Sent) => s.body !== undefined && s.method !== 'GET';
const hdrs = (s: Sent): [string, string][] => [
  ...s.headers,
  ...(withBody(s) ? ([['Content-Type', 'application/json']] as [string, string][]) : []),
];

function curl(s: Sent): string {
  const parts = [`curl -X ${s.method} "${s.url}"`, `  -H "Authorization: Bearer $${KEY}"`];
  for (const [k, v] of hdrs(s)) parts.push(`  -H "${k}: ${v.replaceAll('"', '\\"')}"`);
  if (withBody(s)) parts.push(`  -d '${json(s.body as Json).replaceAll("'", "'\\''")}'`);
  return parts.join(' \\\n');
}

function ts(s: Sent): string {
  const head = [`    Authorization: \`Bearer \${process.env.${KEY}}\`,`];
  for (const [k, v] of hdrs(s)) head.push(`    '${k}': ${tsValue(v)},`);
  const body = withBody(s) ? `\n  body: JSON.stringify(${tsValue(s.body as Json, '  ')}),` : '';
  return [
    `const res = await fetch('${s.url}', {`,
    `  method: '${s.method}',`,
    '  headers: {',
    ...head,
    `  },${body}`,
    '})',
    'console.log(res.status, await res.json())',
  ].join('\n');
}

function py(s: Sent): string {
  const head = [`"Authorization": f"Bearer {os.environ['${KEY}']}"`];
  for (const [k, v] of hdrs(s).filter(([name]) => name !== 'Content-Type'))
    head.push(`${JSON.stringify(k)}: ${JSON.stringify(v)}`);
  const args = [`    "${s.url}",`, `    headers={${head.join(', ')}},`];
  if (withBody(s)) args.push(`    json=${pyValue(s.body as Json, '    ')},`);
  return [
    'import os',
    'import httpx',
    '',
    `res = httpx.${s.method.toLowerCase()}(`,
    ...args,
    ')',
    'print(res.status_code, res.json())',
  ].join('\n');
}

function go(s: Sent): string {
  const body = withBody(s);
  return [
    'package main',
    '',
    'import (',
    '\t"fmt"',
    '\t"io"',
    '\t"net/http"',
    '\t"os"',
    ...(body ? ['\t"strings"'] : []),
    ')',
    '',
    'func main() {',
    ...(body ? [`\tbody := strings.NewReader(\`${json(s.body as Json)}\`)`] : []),
    `\treq, err := http.NewRequest("${s.method}", "${s.url}", ${body ? 'body' : 'nil'})`,
    '\tif err != nil {',
    '\t\tpanic(err)',
    '\t}',
    `\treq.Header.Set("Authorization", "Bearer "+os.Getenv("${KEY}"))`,
    ...hdrs(s).map(([k, v]) => `\treq.Header.Set(${JSON.stringify(k)}, ${JSON.stringify(v)})`),
    '\tres, err := http.DefaultClient.Do(req)',
    '\tif err != nil {',
    '\t\tpanic(err)',
    '\t}',
    '\tdefer res.Body.Close()',
    '\tout, _ := io.ReadAll(res.Body)',
    '\tfmt.Println(res.Status, string(out))',
    '}',
  ].join('\n');
}

const BY: Record<CopyLang, (s: Sent) => string> = { ts, curl, py, go };

/** The request as code in one language, ready to run with the key in `$PASSBOOK_KEY`. */
export const copyAs = (lang: CopyLang, sent: Sent): string => BY[lang](sent);
