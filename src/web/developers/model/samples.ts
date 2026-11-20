import type { Lang } from './highlight.ts';
import { pathValue } from './ids.ts';
import { bodyOf, queryOf, tsSample } from './sample-ts.ts';
import type { Json, OpView } from './types.ts';

export interface Sample {
  lang: Lang;
  label: string;
  file: string;
  code: string;
}

const KEY = 'PASSBOOK_KEY';
const json = (v: Json) => JSON.stringify(v, null, 2);

const hasBody = (op: OpView) => bodyOf(op) !== undefined || op.binary;
const bodyJson = (op: OpView) => json(bodyOf(op) ?? {});

/** The path with example ids in it, and the query the call needs. */
function target(op: OpView, base: string): string {
  const type = (name: string) => op.fields.find((f) => f.where === 'path' && f.name === name)?.type;
  const path = op.path.replace(/\{(\w+)\}/g, (_, n: string) =>
    pathValue(op.path, n, type(n) ?? 'string'),
  );
  const query = Object.entries(queryOf(op))
    .map(([k, v]) => `${k}=${encodeURIComponent(String(v))}`)
    .join('&');
  return `${base}${path}${query ? `?${query}` : ''}`;
}

function curl(op: OpView, base: string): string {
  const parts = [
    `curl -X ${op.method.toUpperCase()} "${target(op, base)}"`,
    `  -H "Authorization: Bearer $${KEY}"`,
  ];
  if (op.idempotent) parts.push('  -H "Idempotency-Key: $(uuidgen)"');
  for (const [k, v] of Object.entries(op.sample.headers)) parts.push(`  -H "${k}: ${v}"`);
  if (op.binary) {
    parts.push('  -H "Content-Type: image/png"', '  --data-binary @image.png');
  } else if (hasBody(op)) {
    parts.push('  -H "Content-Type: application/json"', `  -d '${bodyJson(op)}'`);
  }
  return parts.join(' \\\n');
}

/** A Python literal for a JSON value. */
function pyValue(v: Json, pad = ''): string {
  if (v === null) return 'None';
  if (typeof v === 'boolean') return v ? 'True' : 'False';
  if (typeof v !== 'object') return JSON.stringify(v);
  const inner = `${pad}    `;
  if (Array.isArray(v)) {
    return v.length === 0
      ? '[]'
      : `[\n${v.map((x) => inner + pyValue(x, inner)).join(',\n')},\n${pad}]`;
  }
  const entries = Object.entries(v);
  if (entries.length === 0) return '{}';
  const rows = entries.map(([k, x]) => `${inner}${JSON.stringify(k)}: ${pyValue(x, inner)}`);
  return `{\n${rows.join(',\n')},\n${pad}}`;
}

function py(op: OpView, base: string): string {
  const headers = [`"Authorization": f"Bearer {os.environ['${KEY}']}"`];
  if (op.idempotent) headers.push('"Idempotency-Key": str(uuid.uuid4())');
  for (const [k, v] of Object.entries(op.sample.headers)) headers.push(`"${k}": "${v}"`);
  if (op.binary) headers.push('"Content-Type": "image/png"');
  const args = [`    "${target(op, base)}",`, `    headers={${headers.join(', ')}},`];
  if (op.binary) args.push('    content=open("image.png", "rb").read(),');
  else if (hasBody(op)) args.push(`    json=${pyValue(bodyOf(op) ?? {}, '    ')},`);
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

function go(op: OpView, base: string): string {
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
    ...(op.binary
      ? ['\tbody, err := os.Open("image.png")', '\tif err != nil {', '\t\tpanic(err)', '\t}']
      : body
        ? [`\tbody := strings.NewReader(\`${bodyJson(op)}\`)`]
        : []),
    `\treq, err := http.NewRequest("${op.method.toUpperCase()}", "${target(op, base)}", ${body ? 'body' : 'nil'})`,
    '\tif err != nil {',
    '\t\tpanic(err)',
    '\t}',
    `\treq.Header.Set("Authorization", "Bearer "+os.Getenv("${KEY}"))`,
    ...(op.idempotent
      ? ['\treq.Header.Set("Idempotency-Key", fmt.Sprint(time.Now().UnixNano()))']
      : []),
    ...Object.entries(op.sample.headers).map(([k, v]) => `\treq.Header.Set("${k}", "${v}")`),
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
export function samplesFor(op: OpView, base: string): Sample[] {
  return [
    { lang: 'curl', label: 'curl', file: 'request.sh', code: curl(op, base) },
    { lang: 'ts', label: 'TypeScript', file: 'request.ts', code: tsSample(op) },
    { lang: 'py', label: 'Python', file: 'request.py', code: py(op, base) },
    { lang: 'go', label: 'Go', file: 'main.go', code: go(op, base) },
  ];
}
