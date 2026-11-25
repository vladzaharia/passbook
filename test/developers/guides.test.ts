/// <reference types="vite/client" />
import { describe, expect, it, vi } from 'vitest';
import openapi from '../../docs/api/openapi.v1.json';
import { prefillFromCurl } from '../../src/web/developers/guide/model.ts';
import {
  type Block,
  blockTexts,
  linksIn,
  parseGuide,
} from '../../src/web/developers/guide/parse.ts';
import { EXAMPLE_IDS } from '../../src/web/developers/model/ids.ts';
import { type Call, kit, snippetWorld } from './snippet-world.ts';

// The snippets import the published name; here it is the source.
vi.mock('@passbook/sdk', () => import('../../sdk/typescript/src/index.ts'));
const PNG_BASE64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
vi.mock('node:fs/promises', () => ({
  readFile: async () => Uint8Array.from(atob(PNG_BASE64), (c) => c.charCodeAt(0)),
}));

const guideText = import.meta.glob<string>('../../docs/developers/guides/*.md', {
  query: '?raw',
  import: 'default',
  eager: true,
});
const snippets = Object.values(
  import.meta.glob<Snippet[]>('../../docs/developers/snippets/guides/index.*.json', {
    import: 'default',
    eager: true,
  }),
).flat();
const guideTs = import.meta.glob('../../docs/developers/snippets/guides/*.ts');
const guideSh = import.meta.glob<string>('../../docs/developers/snippets/guides/*.sh', {
  query: '?raw',
  import: 'default',
  eager: true,
});

interface Snippet {
  id: string;
  ops: string[];
  files: { ts: string; curl?: string };
  sandbox?: string;
  expect?: 'fails' | 'handler';
}
const byId = new Map(snippets.map((s) => [s.id, s]));
const dir = '../../docs/developers/snippets/guides/';

/** Where an operation lives in the contract. */
const ops = new Map<string, { method: string; path: string }>();
for (const [path, item] of Object.entries(openapi.paths))
  for (const [method, op] of Object.entries(item as Record<string, { operationId?: string }>))
    if (op.operationId) ops.set(op.operationId, { method: method.toUpperCase(), path });

/** One thing a guide has the reader do, in order. */
type Step =
  | { kind: 'console'; opId: string; body?: unknown; query?: Record<string, string>; from: string }
  | { kind: 'snippet'; id: string };

function stepsOf(blocks: Block[]): Step[] {
  return blocks.flatMap((b): Step[] => {
    const links = blockTexts(b)
      .flatMap(linksIn)
      .filter((l) => l.target.startsWith('console:'))
      .map(
        (l): Step => ({ kind: 'console', opId: l.target.slice('console:'.length), from: l.text }),
      );
    if (links.length > 0) return links;
    if (b.kind === 'code' && b.run)
      return [{ kind: 'console', opId: b.run, body: JSON.parse(b.text), from: `run=${b.run}` }];
    if (b.kind !== 'run' && b.kind !== 'show') return [];
    const s = byId.get(b.snippet);
    const curl = s?.files.curl ? guideSh[`${dir}${s.files.curl}`] : undefined;
    const run: Step[] =
      b.kind === 'run' && s && curl
        ? [
            {
              kind: 'console',
              opId: s.ops[0] ?? '',
              ...prefillFromCurl(curl, b.snippet),
              from: b.snippet,
            },
          ]
        : [];
    return [{ kind: 'snippet', id: b.snippet }, ...run];
  });
}

const failed = (c: Call) => c.status >= 300;
/** Refusals the guide itself shows and the test expects. */
const EXPECTED: Record<string, string[]> = { 'bulk-import': ['IMPORT_BUSY'] };

describe('guides', () => {
  const files = Object.entries(guideText).map(([path, text]) => ({
    path,
    doc: parseGuide(text, path),
  }));

  it('has the fifteen guides', () => {
    expect(files.length).toBe(15);
  });

  for (const { path, doc } of files) {
    const steps = stepsOf(doc.blocks);
    if (doc.meta.status === 'soon') continue;

    it(`${doc.meta.id}: every step runs in test mode`, async () => {
      const world = await snippetWorld(await kit(), { kind: 'developer' });
      process.env.PASSBOOK_KEY = world.secret;
      vi.stubGlobal('fetch', world.fetch);
      vi.spyOn(console, 'log').mockImplementation(() => undefined);
      // What earlier answers returned, which the reader pastes into the next step: the last created id
      // per resource, and any other id field (`captureId`) by name.
      const made: Record<string, string> = {};
      const fields: Record<string, string> = {};
      const problems: string[] = [];
      expect(steps.length, path).toBeGreaterThan(0);

      for (const step of steps) {
        world.calls.length = 0;
        if (step.kind === 'snippet') {
          const s = byId.get(step.id);
          if (!s) throw new Error(`${doc.meta.id}: no snippet ${step.id}`);
          if (s.expect === 'handler') continue;
          // A snippet runs when it is imported, so each step starts from a fresh module.
          vi.resetModules();
          await guideTs[`${dir}${s.files.ts}`]?.().catch(() => undefined);
          const own = world.calls.filter(
            (c) =>
              !EXPECTED[step.id]?.includes(c.code ?? '') &&
              (s.expect === 'fails' ? c.status < 400 : failed(c) && c.code !== s.sandbox),
          );
          if (world.calls.length === 0) problems.push(`${step.id}: made no request`);
          problems.push(
            ...own.map((c) => `${step.id}: ${c.method} ${c.path} ${c.status} ${c.code}`),
          );
          continue;
        }
        const op = ops.get(step.opId);
        if (!op) throw new Error(`${doc.meta.id}: no operation ${step.opId}`);
        const segment = op.path.split('/')[3] ?? '';
        const url = new URL(
          `https://passbook.mobile${op.path.replace(/\{(\w+)\}/g, (_, name: string) =>
            name === 'id'
              ? (made[segment] ?? (segment === 'passes' ? EXAMPLE_IDS.passId : EXAMPLE_IDS.otherId))
              : (fields[name] ?? EXAMPLE_IDS.otherId),
          )}`,
        );
        for (const [k, v] of Object.entries(step.query ?? {})) url.searchParams.set(k, v);
        const res = await world.fetch(url, {
          method: op.method,
          headers: {
            authorization: `Bearer ${world.secret}`,
            ...(step.body === undefined ? {} : { 'content-type': 'application/json' }),
            ...(op.method === 'POST' ? { 'idempotency-key': crypto.randomUUID() } : {}),
          },
          ...(step.body === undefined ? {} : { body: JSON.stringify(step.body) }),
        });
        const call = world.calls.at(-1);
        if (!call || failed(call)) {
          problems.push(
            `${step.from}: ${op.method} ${url.pathname} ${call?.status} ${call?.code} ${call?.detail}`,
          );
          continue;
        }
        const created = (await res
          .clone()
          .json()
          .catch(() => ({}))) as Record<string, unknown> & { endpoint?: { id: string } };
        const id = created.endpoint?.id ?? created.id;
        if (op.method === 'POST' && typeof id === 'string' && !op.path.includes('{'))
          made[segment] = id;
        for (const [k, v] of Object.entries(created)) if (typeof v === 'string') fields[k] = v;
      }
      expect(problems).toEqual([]);
    }, 60_000);
  }
});
