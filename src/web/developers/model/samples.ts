import { goName, pascal, pyName } from '../../../shared/sdk-names.ts';
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

/** The request in four languages: curl, and the TypeScript, Python and Go SDKs. */
export function samplesFor(op: SampleOp, base: string): Sample[] {
  return [
    { lang: 'curl', label: 'curl', file: 'request.sh', code: curl(op, base) },
    { lang: 'ts', label: 'TypeScript', file: 'request.ts', code: tsSample(op) },
    { lang: 'py', label: 'Python', file: 'request.py', code: py(op) },
    { lang: 'go', label: 'Go', file: 'main.go', code: go(op) },
  ];
}
