// Fills docs/api/reference with examples from the fictional world (tools/lib/example-world.ts) wherever an operation
// has none, or its example fails the content lint. Examples that pass are kept, so hand-written ones stay.
// `--all` rewrites every example, hand-written ones included except the headline set.
// `node tools/gen-reference-examples.ts [--all]`, then regenerate the snapshot (openapi-snapshot -u) and `npm run gen`.
import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { validateAgainst } from '../test/helpers/openapi-validate.ts';
import { HEADLINE, HEADLINE_VARIANTS, SCAN_ANSWERS, scanAnswer } from './lib/example-headline.ts';
import { type Example, exampleFailures, examplesOf } from './lib/example-lint.ts';
import { type Ctx, kindOfOp, sample } from './lib/example-sampler.ts';

const root = resolve(import.meta.dirname, '..');
const refDir = resolve(root, 'docs/api/reference');
const doc = JSON.parse(readFileSync(resolve(root, 'docs/api/openapi.v1.json'), 'utf8'));
const files: Record<string, Record<string, Record<string, unknown>>> = {};
for (const f of readdirSync(refDir))
  files[f] = JSON.parse(readFileSync(resolve(refDir, f), 'utf8'));
const fileOf = (id: string): string =>
  Object.keys(files).find((f) => id in (files[f] ?? {})) ?? `${id.split('.')[0]}.json`;

const failures = exampleFailures(doc);
const all = process.argv.includes('--all');
const bad = new Set(failures.flatMap((m) => m.match(/^\S+ (?:request|response)/) ?? []));
// A value reused across operations is bad in every example that holds it.
const reused = failures.flatMap((m) => m.match(/^"([^"]+)" is a regex sample reused/)?.[1] ?? []);
for (const ex of examplesOf(doc))
  if (reused.some((v) => JSON.stringify(ex.value).includes(`"${v}"`))) bad.add(ex.where);
const have = new Set(examplesOf(doc).map((e) => e.where));
const unknown = new Set<string>();
let written = 0;
type Entry = Record<string, unknown>;
/** Files merge per field, the later name winning: set the field wherever it is already defined. */
const setField = (id: string, field: string, value: unknown): void => {
  const holders = Object.values(files).filter((f) => f[id]?.[field] !== undefined);
  if (!holders.length) {
    const name = fileOf(id);
    files[name] ??= {};
    holders.push(files[name] as Record<string, Entry>);
  }
  for (const f of holders) {
    f[id] ??= {};
    (f[id] as Entry)[field] = value;
  }
};

// biome-ignore lint/suspicious/noExplicitAny: the OpenAPI document is untyped JSON here
for (const [, item] of Object.entries<Record<string, any>>(doc.paths))
  for (const op of Object.values(item)) {
    if (!op?.operationId || !op.security?.some((s: object) => 'apiKey' in s)) continue;
    const id = op.operationId as string;
    const tag = id.split('.')[0] as string;
    const make = (field: 'request' | 'response', schema: object) => {
      const where = `${id} ${field}`;
      if (have.has(where) && !bad.has(where) && !all) return;
      const ctx: Ctx = { doc, kind: kindOfOp(tag), op: id, request: field === 'request', unknown };
      let value = sample(ctx, schema, 'body', '', ctx.kind, 0);
      if (field === 'response' && SCAN_ANSWERS.has(id))
        value = scanAnswer(value as Record<string, unknown>);
      const ex: Example = { where, value, schema, op: id };
      const left = exampleFailures(doc, [ex]);
      const invalid = validateAgainst(doc, schema, value);
      if (left.length || invalid.length)
        console.log(
          [
            ...left.slice(0, 3),
            ...invalid
              .filter((e) => !/subschema|does not match schema/.test(e))
              .slice(0, 2)
              .map((e) => `${where}: ${e}`),
          ].join('\n'),
        );
      setField(id, field, value);
      written++;
    };
    const rq = op.requestBody?.content?.['application/json'];
    if (rq?.schema) make('request', rq.schema);
    // biome-ignore lint/suspicious/noExplicitAny: the OpenAPI document is untyped JSON here
    const ok = Object.entries<any>(op.responses ?? {}).find(([c]) => c.startsWith('2'));
    const rs = ok?.[1].content?.['application/json'];
    if (rs?.schema) make('response', rs.schema);
  }
for (const [where, value] of Object.entries(HEADLINE)) {
  const [id, field] = where.split(' ') as [string, string];
  setField(id, field, value);
}
for (const [id, variants] of Object.entries(HEADLINE_VARIANTS)) setField(id, 'requests', variants);
if (all)
  for (const f of Object.values(files))
    for (const [id, entry] of Object.entries(f))
      if (!(id in HEADLINE_VARIANTS)) delete entry.requests;
// Named variants that fail the lint are dropped; the main example stays.
for (const m of failures.filter((m) => /^\S+ requests\[/.test(m))) {
  const id = m.split(' ')[0] as string;
  if (!(id in HEADLINE_VARIANTS))
    for (const f of Object.values(files)) if (f[id]) delete f[id].requests;
}
for (const [f, v] of Object.entries(files))
  writeFileSync(resolve(refDir, f), `${JSON.stringify(v, null, 2)}\n`);
console.log(
  `gen-reference-examples: wrote ${written}; fields with no rule: ${[...unknown].sort().join(', ') || 'none'}`,
);
