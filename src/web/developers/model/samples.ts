import { type SampleSdks, SDK_STATUS } from '../../../shared/developers-sdk.ts';
import { goName, pascal, pyName } from '../../../shared/sdk-names.ts';
import {
  goRawString,
  goString,
  jsonText,
  pyLiteral,
  pyString,
  shQuote,
  tsKey,
  tsLiteral,
  tsString,
} from './code-literals.ts';
import type { Lang } from './highlight.ts';
import { pathValue } from './ids.ts';
import { bodyOf, queryOf, type SampleOp, tsSample } from './sample-ts.ts';
import type { Example } from './types.ts';

export interface Sample {
  lang: Lang;
  label: string;
  file: string;
  code: string;
  /** The tool is not published yet: the tab says so. */
  soon?: boolean;
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
  if (op.idempotent) parts.push('  -H "Idempotency-Key: qs-$(date +%s)-$RANDOM"');
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

/** Plain `fetch`, for as long as @passbook/sdk is not published. */
function tsPlain(op: SampleOp, base: string): string {
  const headers = [`Authorization: \`Bearer \${process.env.${KEY}}\``];
  if (op.idempotent) headers.push("'Idempotency-Key': crypto.randomUUID()");
  for (const [k, v] of Object.entries(op.sample.headers))
    headers.push(`${tsKey(k)}: ${tsString(v)}`);
  if (op.binary) headers.push("'Content-Type': 'image/png'");
  else if (hasBody(op)) headers.push("'Content-Type': 'application/json'");
  const body = op.binary
    ? ["  body: await readFile('image.png'),"]
    : hasBody(op)
      ? [`  body: JSON.stringify(${tsLiteral(bodyOf(op) ?? {}, '  ')}),`]
      : [];
  return [
    ...(op.binary ? ["import { readFile } from 'node:fs/promises';", ''] : []),
    `const res = await fetch(${tsString(target(op, base))}, {`,
    `  method: ${tsString(op.method.toUpperCase())},`,
    '  headers: {',
    ...headers.map((h) => `    ${h},`),
    '  },',
    ...body,
    '});',
    op.download ? 'console.log(res.status);' : 'console.log(res.status, await res.json());',
  ].join('\n');
}

/** Plain `requests`, for as long as passbook-sdk is not published. */
function pyPlain(op: SampleOp, base: string): string {
  const headers = [`"Authorization": f"Bearer {os.environ['${KEY}']}"`];
  if (op.idempotent) headers.push('"Idempotency-Key": str(uuid.uuid4())');
  for (const [k, v] of Object.entries(op.sample.headers))
    headers.push(`${pyString(k)}: ${pyString(v)}`);
  if (op.binary) headers.push('"Content-Type": "image/png"');
  const args = [`    ${pyString(target(op, base))},`, `    headers={${headers.join(', ')}},`];
  if (op.binary) args.push('    data=open("image.png", "rb").read(),');
  else if (hasBody(op)) args.push(`    json=${pyLiteral(bodyOf(op) ?? {}, '    ')},`);
  return [
    `import os${op.idempotent ? ', uuid' : ''}`,
    '',
    'import requests',
    '',
    `res = requests.${op.method}(`,
    ...args,
    ')',
    'res.raise_for_status()',
    op.download ? 'print(res.status_code)' : 'print(res.json())',
  ].join('\n');
}

/** Plain `net/http`, for as long as the Go module is not published. */
function goPlain(op: SampleOp, base: string): string {
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

/** Arguments on one line when they fit, else one per line (each already indented for it). */
function callArgs(args: string[]): string {
  if (args.length === 0) return '()';
  if (args.every((a) => !a.includes('\n')) && args.join(', ').length < 60)
    return `(${args.join(', ')})`;
  return `(\n${args.map((a) => `    ${a},`).join('\n')}\n)`;
}

function pathArgs(op: SampleOp, literal: (v: string, numeric: boolean) => string): string[] {
  const type = (name: string) => op.fields.find((f) => f.where === 'path' && f.name === name)?.type;
  return [...op.path.matchAll(/\{(\w+)\}/g)].map((m) => {
    const t = type(m[1] ?? '') ?? 'string';
    return literal(pathValue(op.path, m[1] ?? '', t), /^(integer|number)/.test(t));
  });
}

/** One call through `passbook`: path ids first, then the body as a dict, then the query as keywords. */
function py(op: SampleOp): string {
  const args = pathArgs(op, (v, numeric) => (numeric ? v : pyString(v)));
  if (op.binary) args.push('open("image.png", "rb").read()');
  else if (hasBody(op)) args.push(pyLiteral(bodyOf(op) ?? {}, '    '));
  for (const [k, v] of Object.entries(queryOf(op)))
    args.push(`${pyName(k)}=${pyLiteral(v, '    ')}`);
  if (Object.keys(op.sample.headers).length > 0)
    args.push(`headers=${pyLiteral(op.sample.headers, '    ')}`);
  const call = `pb.${op.sdkCall.slice(3).split('.').map(pyName).join('.')}${callArgs(args)}`;
  const use = op.cursorList
    ? [`for item in ${call}:`, '    print(item)']
    : op.download
      ? [`res = ${call}`, 'print(res.status_code)']
      : op.noContent
        ? [call]
        : [`result = ${call}`, 'print(result)'];
  return [
    'import os',
    '',
    'from passbook import PassBook',
    '',
    `pb = PassBook(api_key=os.environ["${KEY}"])`,
    '',
    ...use,
  ].join('\n');
}

const GO_MODULE = 'github.com/vladzaharia/passbook/sdk/go';

/** Text decoded into a typed value: the SDK's bodies and queries are structs, the samples are JSON. */
const goDecode = (name: string, type: string, json: string) => [
  `\tvar ${name} passbook.${type}`,
  `\tif err := json.Unmarshal([]byte(${goRawString(json)}), &${name}); err != nil {`,
  '\t\tpanic(err)',
  '\t}',
  '',
];

/** One call through the Go SDK: bodies and queries are decoded from JSON into the SDK's types. */
function go(op: SampleOp): string {
  const name = op.sdkCall.slice(3);
  const type = pascal(name);
  const body = hasBody(op) && !op.binary;
  const query = queryOf(op);
  const hasQuery = Object.keys(query).length > 0;
  const takesQuery = hasQuery || op.fields.some((f) => f.where === 'query');
  const args = ['ctx', ...pathArgs(op, (v, numeric) => (numeric ? v : goString(v)))];
  if (body) args.push('&body');
  if (op.binary) args.push('body');
  if (takesQuery) args.push(hasQuery ? '&query' : 'nil');
  for (const [k, v] of Object.entries(op.sample.headers))
    args.push(`passbook.WithHeader(${goString(k)}, ${goString(v)})`);
  const call = `pb.${name.split('.').map(goName).join('.')}(${args.join(', ')})`;
  const fail = ['\tif err != nil {', '\t\tpanic(err)', '\t}'];
  const use = op.cursorList
    ? [
        `\tpager := ${call}`,
        '\tfor pager.Next(ctx) {',
        '\t\tfmt.Printf("%+v\\n", pager.Item())',
        '\t}',
        '\tif err := pager.Err(); err != nil {',
        '\t\tpanic(err)',
        '\t}',
      ]
    : op.download
      ? [`\tres, err := ${call}`, ...fail, '\tdefer res.Body.Close()', '\tfmt.Println(res.Status)']
      : op.noContent
        ? [`\tif err := ${call}; err != nil {`, '\t\tpanic(err)', '\t}', '\tfmt.Println("ok")']
        : [`\tresult, err := ${call}`, ...fail, '\tfmt.Printf("%+v\\n", result)'];
  const needsJson = body || hasQuery;
  return [
    'package main',
    '',
    'import (',
    '\t"context"',
    ...(needsJson ? ['\t"encoding/json"'] : []),
    '\t"fmt"',
    '\t"os"',
    '',
    `\tpassbook "${GO_MODULE}"`,
    ')',
    '',
    'func main() {',
    '\tctx := context.Background()',
    `\tpb, err := passbook.NewClient(os.Getenv("${KEY}"))`,
    ...fail,
    '',
    ...(body ? goDecode('body', `${type}Body`, bodyJson(op)) : []),
    ...(op.binary ? ['\tbody, err := os.ReadFile("image.png")', ...fail, ''] : []),
    ...(hasQuery ? goDecode('query', `${type}Query`, jsonText(query)) : []),
    ...use,
    '}',
  ].join('\n');
}

/** The request in four languages: curl, then each language through its SDK once published, else plain HTTP. */
export function samplesFor(op: SampleOp, base: string, sdk: SampleSdks = SDK_STATUS): Sample[] {
  return [
    { lang: 'curl', label: 'curl', file: 'request.sh', code: curl(op, base) },
    {
      lang: 'ts',
      label: 'TypeScript',
      file: 'request.ts',
      code: sdk.typescript ? tsSample(op) : tsPlain(op, base),
      ...(sdk.typescript ? {} : { soon: true }),
    },
    {
      lang: 'py',
      label: 'Python',
      file: 'request.py',
      code: sdk.python ? py(op) : pyPlain(op, base),
      ...(sdk.python ? {} : { soon: true }),
    },
    {
      lang: 'go',
      label: 'Go',
      file: 'main.go',
      code: sdk.go ? go(op) : goPlain(op, base),
      ...(sdk.go ? {} : { soon: true }),
    },
  ];
}

/**
 * A hand-written example's tabs: curl, and the TypeScript that imports the SDK once it is published.
 * An example with no curl keeps its TypeScript, which is all it has.
 */
export function exampleSamples(e: Example, sdk: SampleSdks = SDK_STATUS): Sample[] {
  const curlTab: Sample[] = e.curl
    ? [{ lang: 'curl', label: 'curl', file: `${e.id}.sh`, code: e.curl }]
    : [];
  return sdk.typescript || !e.curl
    ? [...curlTab, { lang: 'ts', label: 'TypeScript', file: `${e.id}.ts`, code: e.ts }]
    : curlTab;
}
