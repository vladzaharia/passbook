import {
  goString,
  jsonText,
  pyLiteral,
  pyString,
  shQuote,
  tsKey,
  tsLiteral,
  tsString,
} from '../../developers/model/code-literals.ts';
import type { Lang } from '../../developers/model/highlight.ts';
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

/**
 * Every value below (URL, header names and values, body) is written as the language's own string
 * literal by model/code-literals.ts. Only fixed text in this file is ever code: the key is read from
 * the environment, and in curl it is the one thing left to expand.
 */
const KEY = 'PASSBOOK_KEY';
const withBody = (s: Sent) => s.body !== undefined && s.method !== 'GET';
/** The bearer is never copied: a header named Authorization is dropped, whatever put it there (the Workbench token included). */
const hdrs = (s: Sent): [string, string][] => [
  ...s.headers.filter(([name]) => name.toLowerCase() !== 'authorization'),
  ...(withBody(s) ? ([['Content-Type', 'application/json']] as [string, string][]) : []),
];
/** The verb comes from the document; anything that is not letters is not a verb. */
const verb = (s: Sent): string => (/^[A-Z]{3,7}$/.test(s.method) ? s.method : 'GET');

function curl(s: Sent): string {
  const parts = [`curl -X ${verb(s)} ${shQuote(s.url)}`, `  -H "Authorization: Bearer $${KEY}"`];
  for (const [k, v] of hdrs(s)) parts.push(`  -H ${shQuote(`${k}: ${v}`)}`);
  if (withBody(s)) parts.push(`  -d ${shQuote(jsonText(s.body as Json))}`);
  return parts.join(' \\\n');
}

function ts(s: Sent): string {
  const head = [`    Authorization: \`Bearer \${process.env.${KEY}}\`,`];
  for (const [k, v] of hdrs(s)) head.push(`    ${tsKey(k)}: ${tsString(v)},`);
  const body = withBody(s) ? `\n  body: JSON.stringify(${tsLiteral(s.body as Json, '  ')}),` : '';
  return [
    `const res = await fetch(${tsString(s.url)}, {`,
    `  method: ${tsString(verb(s))},`,
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
    head.push(`${pyString(k)}: ${pyString(v)}`);
  const args = [`    ${pyString(s.url)},`, `    headers={${head.join(', ')}},`];
  if (withBody(s)) args.push(`    json=${pyLiteral(s.body as Json, '    ')},`);
  return [
    'import os',
    'import httpx',
    '',
    `res = httpx.request(${pyString(verb(s))},`,
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
    ...(body ? [`\tbody := strings.NewReader(${goString(jsonText(s.body as Json))})`] : []),
    `\treq, err := http.NewRequest(${goString(verb(s))}, ${goString(s.url)}, ${body ? 'body' : 'nil'})`,
    '\tif err != nil {',
    '\t\tpanic(err)',
    '\t}',
    `\treq.Header.Set("Authorization", "Bearer "+os.Getenv("${KEY}"))`,
    ...hdrs(s).map(([k, v]) => `\treq.Header.Set(${goString(k)}, ${goString(v)})`),
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
