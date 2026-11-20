import { goRawString, goString, jsonText, pyLiteral, pyString, shQuote } from './code-literals.ts';
import type { Lang } from './highlight.ts';
import { pathValue } from './ids.ts';
import { bodyOf, queryOf, type SampleOp, tsSample } from './sample-ts.ts';

export interface Sample {
  lang: Lang;
  label: string;
  file: string;
  code: string;
}

const KEY = 'PASSBOOK_KEY';

const hasBody = (op: SampleOp) => bodyOf(op) !== undefined || op.binary;
const bodyJson = (op: SampleOp) => jsonText(bodyOf(op) ?? {});

/** The path with example ids in it, and the query the call needs. */
function target(op: SampleOp, base: string): string {
  const type = (name: string) => op.fields.find((f) => f.where === 'path' && f.name === name)?.type;
  const path = op.path.replace(/\{(\w+)\}/g, (_, n: string) =>
    pathValue(op.path, n, type(n) ?? 'string'),
  );
  const query = Object.entries(queryOf(op))
    .map(([k, v]) => `${k}=${encodeURIComponent(String(v))}`)
    .join('&');
  return `${base}${path}${query ? `?${query}` : ''}`;
}

/** Text as one shell word: the plain double-quoted form when it holds nothing a shell reads, else single-quoted. */
const shWord = (text: string) => (/^[\w:/.<>@%?=&, -]*$/.test(text) ? `"${text}"` : shQuote(text));

function curl(op: SampleOp, base: string): string {
  const parts = [
    `curl -X ${op.method.toUpperCase()} ${shWord(target(op, base))}`,
    `  -H "Authorization: Bearer $${KEY}"`,
  ];
  if (op.idempotent) parts.push('  -H "Idempotency-Key: $(uuidgen)"');
  for (const [k, v] of Object.entries(op.sample.headers))
    parts.push(`  -H ${shWord(`${k}: ${v}`)}`);
  if (op.binary) {
    parts.push('  -H "Content-Type: image/png"', '  --data-binary @image.png');
  } else if (hasBody(op)) {
    // Single quotes expand nothing; shQuote turns each `'` in a value into `'\''`.
    parts.push('  -H "Content-Type: application/json"', `  -d ${shQuote(bodyJson(op))}`);
  }
  return parts.join(' \\\n');
}

function py(op: SampleOp, base: string): string {
  const headers = [`"Authorization": f"Bearer {os.environ['${KEY}']}"`];
  if (op.idempotent) headers.push('"Idempotency-Key": str(uuid.uuid4())');
  for (const [k, v] of Object.entries(op.sample.headers))
    headers.push(`${pyString(k)}: ${pyString(v)}`);
  if (op.binary) headers.push('"Content-Type": "image/png"');
  const args = [`    ${pyString(target(op, base))},`, `    headers={${headers.join(', ')}},`];
  if (op.binary) args.push('    content=open("image.png", "rb").read(),');
  else if (hasBody(op)) args.push(`    json=${pyLiteral(bodyOf(op) ?? {}, '    ')},`);
  return [
    `import os${op.idempotent ? ', uuid' : ''}`,
    'import httpx',
    '',
    `res = httpx.${op.method}(`,
    ...args,
    ')',
    'res.raise_for_status()',
    op.download ? 'print(res.status_code)' : 'print(res.json())',
  ].join('\n');
}

function go(op: SampleOp, base: string): string {
  const body = hasBody(op);
  return [
    'package main',
    '',
    'import (',
    '\t"fmt"',
    '\t"io"',
    '\t"net/http"',
    '\t"os"',
    ...(body && !op.binary ? ['\t"strings"'] : []),
    ...(op.idempotent ? ['\t"time"'] : []),
    ')',
    '',
    'func main() {',
    // A raw string keeps the JSON readable; goRawString joins in any backtick as its own literal.
    ...(op.binary
      ? ['\tbody, err := os.Open("image.png")', '\tif err != nil {', '\t\tpanic(err)', '\t}']
      : body
        ? [`\tbody := strings.NewReader(${goRawString(bodyJson(op))})`]
        : []),
    `\treq, err := http.NewRequest(${goString(op.method.toUpperCase())}, ${goString(target(op, base))}, ${body ? 'body' : 'nil'})`,
    '\tif err != nil {',
    '\t\tpanic(err)',
    '\t}',
    `\treq.Header.Set("Authorization", "Bearer "+os.Getenv("${KEY}"))`,
    ...(op.idempotent
      ? ['\treq.Header.Set("Idempotency-Key", fmt.Sprint(time.Now().UnixNano()))']
      : []),
    ...Object.entries(op.sample.headers).map(
      ([k, v]) => `\treq.Header.Set(${goString(k)}, ${goString(v)})`,
    ),
    ...(body
      ? [`\treq.Header.Set("Content-Type", "${op.binary ? 'image/png' : 'application/json'}")`]
      : []),
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

/** The request in four languages: TypeScript through @passbook/sdk, the rest plain HTTP until the Python and Go SDKs ship. */
export function samplesFor(op: SampleOp, base: string): Sample[] {
  return [
    { lang: 'curl', label: 'curl', file: 'request.sh', code: curl(op, base) },
    { lang: 'ts', label: 'TypeScript', file: 'request.ts', code: tsSample(op) },
    { lang: 'py', label: 'Python', file: 'request.py', code: py(op, base) },
    { lang: 'go', label: 'Go', file: 'main.go', code: go(op, base) },
  ];
}
