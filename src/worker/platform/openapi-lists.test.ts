import { describe, expect, it } from 'vitest';
import { fakeAuth } from '../../../test/helpers/index.ts';
import { createApp } from '../app.ts';
import { buildOpenApiDocument } from './openapi-document.ts';

type Param = { name: string; in: string; deprecated?: boolean; 'x-platform-only'?: boolean };
type Op = {
  operationId: string;
  parameters?: Param[];
  responses?: Record<string, { content?: Record<string, { schema?: Schema }> }>;
};
type Schema = { $ref?: string; properties?: Record<string, unknown> };
type Doc = {
  paths: Record<string, Record<string, Op>>;
  components: { schemas: Record<string, Schema> };
};

const doc = buildOpenApiDocument(createApp({ stores: fakeAuth().stores })) as unknown as Doc;
const ops = Object.entries(doc.paths).flatMap(([path, item]) =>
  Object.entries(item).map(([method, op]) => ({ path, method, op })),
);
/** A 200 body's schema, with a named one (`$ref`) read through the components. */
const bodyOf = (op: Op): Schema | undefined => {
  const schema = op.responses?.['200']?.content?.['application/json']?.schema;
  return schema?.$ref ? doc.components.schemas[schema.$ref.split('/').pop() ?? ''] : schema;
};
const queryNames = (op: Op) => (op.parameters ?? []).filter((p) => p.in === 'query');

/** Reads one object, one map or one result, or a set with a hard cap (a pass's notes, a session's scanners): no collection to page. */
const NOT_COLLECTIONS = new Set([
  '/api/v1/orgs/{id}/entitlements',
  '/api/v1/platform/orgs/{id}/entitlements',
  '/api/v1/templates/previews',
  '/api/v1/delivery',
  '/api/v1/settings',
  '/api/v1/platform/settings',
  '/api/v1/scan/passes/{passId}/notes',
  '/api/v1/scan/devices',
  '/api/v1/identities/{id}/certificates',
  '/api/v1/platform/apple-calls',
  // Found once the filter read named schemas: each is a capped list, not a collection to page.
  '/api/v1/passes/views',
  '/api/v1/webhook-endpoints/{id}/tests',
  // One row per endpoint of an event: capped by the endpoint limit.
  '/api/v1/events/{id}/deliveries',
  '/api/v1/scan/activity',
  '/api/v1/scan/scans',
  '/api/v1/platform/idp/drift',
]);
/** Streams keep `after`: a position in an ordered log, not a page. */
const STREAMS = new Set(['/api/v1/events', '/api/v1/scan/live']);

const collections = ops.filter(({ path, method, op }) => {
  const schema = bodyOf(op);
  return (
    method === 'get' &&
    path.startsWith('/api/v1/') &&
    !NOT_COLLECTIONS.has(path) &&
    schema?.properties &&
    'items' in schema.properties
  );
});

describe('collection GETs', () => {
  it('finds the collections', () => {
    expect(collections.length).toBeGreaterThan(60);
  });

  it('return nextCursor in the page', () => {
    const missing = collections.filter(({ op }) => {
      const props = bodyOf(op)?.properties;
      return !props || !('nextCursor' in props);
    });
    expect(missing.map((m) => m.path)).toEqual([]);
  });

  it('take cursor, and only the two streams take after', () => {
    const noCursor = collections.filter(
      ({ path, op }) => !STREAMS.has(path) && !queryNames(op).some((p) => p.name === 'cursor'),
    );
    expect(noCursor.map((m) => m.path)).toEqual([]);
    const afters = collections.filter(({ path, op }) =>
      queryNames(op).some((p) => p.name === 'after' && !p.deprecated && !STREAMS.has(path)),
    );
    expect(afters.map((m) => m.path)).toEqual([]);
  });
});

describe('parameter marks', () => {
  const pairs = { from: 'createdAfter', to: 'createdBefore', since: 'updatedSince' };

  it('mark an old time name deprecated wherever its alias exists', () => {
    let seen = 0;
    for (const { op } of ops) {
      const names = queryNames(op);
      for (const [old, alias] of Object.entries(pairs)) {
        const p = names.find((q) => q.name === old);
        if (!p || !names.some((q) => q.name === alias)) continue;
        seen++;
        expect(p.deprecated).toBe(true);
      }
    }
    expect(seen).toBeGreaterThanOrEqual(6);
  });

  it('offer the aliases on audit, scans, roster and summary', () => {
    const has = (path: string, name: string) =>
      queryNames(doc.paths[path]?.get as Op).some((p) => p.name === name);
    expect(has('/api/v1/audit', 'createdAfter')).toBe(true);
    expect(has('/api/v1/audit/platform', 'createdBefore')).toBe(true);
    expect(has('/api/v1/scans', 'createdAfter')).toBe(true);
    expect(has('/api/v1/scan/roster', 'updatedSince')).toBe(true);
    expect(has('/api/v1/scan/summary', 'updatedSince')).toBe(true);
  });

  it('tag every orgId query parameter x-platform-only', () => {
    const orgIds = ops.flatMap(({ op }) => queryNames(op).filter((p) => p.name === 'orgId'));
    expect(orgIds.length).toBeGreaterThan(50);
    expect(orgIds.filter((p) => !p['x-platform-only'])).toEqual([]);
  });
});
