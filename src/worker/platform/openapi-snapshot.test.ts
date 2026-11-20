import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import frozenRaw from '../../../docs/api/operation-ids.json?raw';
import { fakeAuth } from '../../../test/helpers/index.ts';
import type { Doc } from '../../../tools/lib/openapi-diff.ts';
import { createApp } from '../app.ts';
import { buildOpenApiDocument } from './openapi-document.ts';

const root = resolve(import.meta.dirname, '../../..');
const METHODS = ['get', 'post', 'put', 'patch', 'delete'];

const live = buildOpenApiDocument(createApp({ stores: fakeAuth().stores })) as Doc;
const ids = (doc: Doc): string[] =>
  Object.values(doc.paths ?? {}).flatMap((item) =>
    METHODS.flatMap((m) => {
      const op = item[m] as { operationId?: string } | undefined;
      return op ? [op.operationId ?? ''] : [];
    }),
  );

// Rewrite both files after an intended change: `npx vitest run --project worker openapi-snapshot -u`.
describe('openapi document', () => {
  it('gives every operation a unique, well-formed operationId', () => {
    const all = ids(live);
    expect(all.length).toBeGreaterThan(300);
    expect(all.filter((id) => !/^[a-z0-9-]+\.[a-z]+[A-Za-z0-9]*$/.test(id))).toEqual([]);
    expect(all.filter((id, i) => all.indexOf(id) !== i)).toEqual([]);
  });

  it('keeps every frozen operationId', () => {
    const now = new Set(ids(live));
    expect((JSON.parse(frozenRaw) as string[]).filter((id) => !now.has(id))).toEqual([]);
  });

  it('matches the committed snapshot and id list', async () => {
    await expect(`${JSON.stringify(live, null, 2)}\n`).toMatchFileSnapshot(
      resolve(root, 'docs/api/openapi.v1.json'),
    );
    await expect(`${JSON.stringify(ids(live).sort(), null, 2)}\n`).toMatchFileSnapshot(
      resolve(root, 'docs/api/operation-ids.json'),
    );
  });
});
