// Writes the request and response examples in docs/api/reference from the fictional world (tools/lib/example-world.ts):
// every example is sampled from its schema, or taken from the hand-written set (example-headline.ts) where there is
// one, so the committed examples are a function of the world and the schemas. Descriptions are kept.
// `node tools/gen-reference-examples.ts` writes (biome-formatted), then regenerate the snapshot (openapi-snapshot -u)
// and `npm run gen`. `--check` writes nothing and fails when the committed examples differ (run in `npm run check:rules`).
import { spawnSync } from 'node:child_process';
import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { relative, resolve } from 'node:path';
import { validateAgainst } from '../test/helpers/openapi-validate.ts';
import { HEADLINE, HEADLINE_VARIANTS, ROTATIONS, rotateAnswer } from './lib/example-headline.ts';
import { type Example, exampleFailures } from './lib/example-lint.ts';
import { missing } from './lib/example-names.ts';
import { type Ctx, kindOfOp, sample, unwritten } from './lib/example-sampler.ts';
import { SEEDS } from './lib/example-seeds.ts';

const root = resolve(import.meta.dirname, '..');
const refDir = resolve(root, 'docs/api/reference');
const doc = JSON.parse(readFileSync(resolve(root, 'docs/api/openapi.v1.json'), 'utf8'));
const check = process.argv.includes('--check');

type Entry = Record<string, unknown>;
const disk: Record<string, Record<string, Entry>> = {};
for (const f of readdirSync(refDir).filter((f) => f.endsWith('.json')))
  disk[f] = JSON.parse(readFileSync(resolve(refDir, f), 'utf8'));
const files: Record<string, Record<string, Entry>> = structuredClone(disk);
const fileOf = (id: string): string =>
  Object.keys(files).find((f) => id in (files[f] ?? {})) ?? `${id.split('.')[0]}.json`;

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

const unknown = new Set<string>();
const problems: string[] = [];
const used = new Set<string>();
const written: Example[] = [];
// biome-ignore lint/suspicious/noExplicitAny: the OpenAPI document is untyped JSON here
for (const [, item] of Object.entries<Record<string, any>>(doc.paths))
  for (const op of Object.values(item)) {
    if (!op?.operationId) continue;
    const id = op.operationId as string;
    const tag = id.split('.')[0] as string;
    const make = (field: 'request' | 'response', schema: object) => {
      const where = `${id} ${field}`;
      const ctx: Ctx = { doc, kind: kindOfOp(tag), op: id, request: field === 'request', unknown };
      let value: unknown;
      if (where in HEADLINE) {
        value = HEADLINE[where];
        used.add(where);
      } else {
        value = sample(ctx, schema, 'body', '', ctx.kind, 0, SEEDS[where]);
        if (field === 'response' && ROTATIONS.has(id))
          value = rotateAnswer(value as Record<string, unknown>);
      }
      written.push({ where, value, schema, op: id });
      // The committed set is validated by openapi-examples.test.ts; a write validates what it is about to commit.
      if (!check)
        problems.push(
          ...validateAgainst(doc, schema, value)
            .filter((e) => !/subschema|does not match schema/.test(e))
            .map((e) => `${where}: ${e}`),
        );
      setField(id, field, value);
    };
    const rq = op.requestBody?.content?.['application/json'];
    if (rq?.schema) make('request', rq.schema);
    // biome-ignore lint/suspicious/noExplicitAny: the OpenAPI document is untyped JSON here
    const ok = Object.entries<any>(op.responses ?? {}).find(([c]) => c.startsWith('2'));
    const rs = ok?.[1].content?.['application/json'];
    if (rs?.schema) make('response', rs.schema);
  }
for (const f of Object.values(files))
  for (const [id, entry] of Object.entries(f))
    if (id in HEADLINE_VARIANTS) entry.requests = HEADLINE_VARIANTS[id];
    else delete entry.requests;

const fail = (lines: string[], what: string): void => {
  if (!lines.length) return;
  console.error(`gen-reference-examples: ${lines.length} ${what}:\n  ${lines.join('\n  ')}`);
  process.exitCode = 1;
};
fail([...missing], 'name field(s) with no table');
fail([...unwritten], 'free-text field(s) with no sentence in tools/lib/example-text.ts');
fail(
  Object.keys(HEADLINE).filter((w) => !used.has(w)),
  'hand-written example(s) for no JSON body',
);
if (!check) problems.push(...exampleFailures(doc, written));
fail(problems, 'example(s) that fail the lint or the schema');
// Compared as JSON, as written: a key whose value is undefined is not in the file.
const changed = Object.keys(files).filter(
  (f) => JSON.stringify(files[f]) !== JSON.stringify(disk[f]),
);
if (check)
  fail(
    changed.map((f) => `docs/api/reference/${f}`),
    'file(s) out of date; run node tools/gen-reference-examples.ts',
  );
else {
  for (const f of changed) {
    const path = resolve(refDir, f);
    const fmt = spawnSync(
      resolve(root, 'node_modules/.bin/biome'),
      ['format', `--stdin-file-path=${relative(root, path)}`],
      { input: JSON.stringify(files[f], null, 2), encoding: 'utf8', cwd: root },
    );
    if (fmt.status !== 0) throw new Error(`biome could not format ${f}: ${fmt.stderr}`);
    writeFileSync(path, fmt.stdout);
  }
  console.log(
    `gen-reference-examples: ${changed.length} file(s) written; fields with no rule: ${[...unknown].sort().join(', ') || 'none'}`,
  );
}
