import type { Lang } from './highlight.ts';
import type { Json, OpView } from './types.ts';

export interface Sample {
  lang: Lang;
  label: string;
  file: string;
  code: string;
}

const KEY = 'PASSBOOK_KEY';
const hasBody = (op: OpView) => op.requestExample !== undefined && op.method !== 'get';

/** Path templates as a person fills them: `{id}` becomes `<id>`. */
const target = (op: OpView, base: string) => `${base}${op.path.replace(/\{(\w+)\}/g, '<$1>')}`;
const json = (v: Json) => JSON.stringify(v, null, 2);

/** A TypeScript literal for a JSON value: bare keys, single quotes. */
function tsValue(v: Json, pad = ''): string {
  if (v === null || typeof v !== 'object')
    return typeof v === 'string' ? `'${v.replaceAll("'", "\\'")}'` : String(v);
  const inner = `${pad}  `;
  if (Array.isArray(v)) {
    return v.length === 0
      ? '[]'
      : `[\n${v.map((x) => inner + tsValue(x, inner)).join(',\n')},\n${pad}]`;
  }
  const entries = Object.entries(v);
  if (entries.length === 0) return '{}';
  const key = (k: string) => (/^[A-Za-z_$][\w$]*$/.test(k) ? k : `'${k}'`);
  return `{\n${entries.map(([k, x]) => `${inner}${key(k)}: ${tsValue(x, inner)}`).join(',\n')},\n${pad}}`;
}

function curl(op: OpView, base: string): string {
  const parts = [
    `curl -X ${op.method.toUpperCase()} "${target(op, base)}"`,
    `  -H "Authorization: Bearer $${KEY}"`,
  ];
  if (op.idempotent) parts.push('  -H "Idempotency-Key: $(uuidgen)"');
  if (hasBody(op)) {
    parts.push('  -H "Content-Type: application/json"');
    parts.push(`  -d '${json(op.requestExample as Json)}'`);
  }
  return parts.join(' \\\n');
}

function ts(op: OpView, base: string): string {
  const headers = [`    Authorization: \`Bearer \${process.env.${KEY}}\`,`];
  if (op.idempotent) headers.push("    'Idempotency-Key': crypto.randomUUID(),");
  if (hasBody(op)) headers.push("    'Content-Type': 'application/json',");
  const body = hasBody(op)
    ? `\n  body: JSON.stringify(${tsValue(op.requestExample as Json, '  ')}),`
    : '';
  return [
    `const res = await fetch('${target(op, base)}', {`,
    `  method: '${op.method.toUpperCase()}',`,
    '  headers: {',
    ...headers,
    `  },${body}`,
    '})',
    'console.log(res.status, await res.json())',
  ].join('\n');
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
  const args = [`    "${target(op, base)}",`, `    headers={${headers.join(', ')}},`];
  if (hasBody(op)) args.push(`    json=${pyValue(op.requestExample as Json, '    ')},`);
  return [
    `import os${op.idempotent ? ', uuid' : ''}`,
    'import httpx',
    '',
    `res = httpx.${op.method}(`,
    ...args,
    ')',
    'res.raise_for_status()',
    'print(res.json())',
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
    ...(body ? ['\t"strings"'] : []),
    ...(op.idempotent ? ['\t"time"'] : []),
    ')',
    '',
    'func main() {',
    ...(body ? [`\tbody := strings.NewReader(\`${json(op.requestExample as Json)}\`)`] : []),
    `\treq, err := http.NewRequest("${op.method.toUpperCase()}", "${target(op, base)}", ${body ? 'body' : 'nil'})`,
    '\tif err != nil {',
    '\t\tpanic(err)',
    '\t}',
    `\treq.Header.Set("Authorization", "Bearer "+os.Getenv("${KEY}"))`,
    ...(op.idempotent
      ? ['\treq.Header.Set("Idempotency-Key", fmt.Sprint(time.Now().UnixNano()))']
      : []),
    ...(body ? ['\treq.Header.Set("Content-Type", "application/json")'] : []),
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

/** The request in four languages. None needs an SDK: every sample runs as written with a key. */
export function samplesFor(op: OpView, base: string): Sample[] {
  return [
    { lang: 'curl', label: 'curl', file: 'request.sh', code: curl(op, base) },
    { lang: 'ts', label: 'TypeScript', file: 'request.ts', code: ts(op, base) },
    { lang: 'py', label: 'Python', file: 'request.py', code: py(op, base) },
    { lang: 'go', label: 'Go', file: 'main.go', code: go(op, base) },
  ];
}
