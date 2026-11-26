import { describe, expect, it } from 'vitest';
import { ProbeDetectionsSchema } from '../contracts/connection-probe.ts';
import { detectRateLimit, detectResponse } from './detect.ts';
import { jsonPathToPointer, pointerToJsonPath, recordsJsonPath } from './json-path.ts';
import { linkRels, nextFromLinkHeader } from './link-header.ts';
import { prune } from './prune.ts';

describe('json paths', () => {
  it('writes pointers as JSONPath and back', () => {
    expect(pointerToJsonPath('')).toBe('$');
    expect(pointerToJsonPath('/data/0/name')).toBe('$.data[0].name');
    expect(pointerToJsonPath("/a~1b/first name/it's")).toBe("$['a/b']['first name']['it\\'s']");
    for (const p of ['', '/data', '/data/0/name', '/a~1b/x y', '/~0tilde', "/it's/a\\b"]) {
      expect(jsonPathToPointer(pointerToJsonPath(p))).toBe(p);
    }
  });

  it('marks the records array and the fields inside it', () => {
    expect(recordsJsonPath('/data')).toBe('$.data[*]');
    expect(recordsJsonPath('')).toBe('$[*]');
    expect(recordsJsonPath('/data', '/user/email')).toBe('$.data[*].user.email');
  });

  it('refuses a path that is not plain', () => {
    for (const p of ['data', '$.data[*]', '$..x', '$.a[?(@.b)]', '$.a[', '$.a[01]']) {
      expect(jsonPathToPointer(p)).toBeNull();
    }
  });
});

describe('prune', () => {
  it('cuts arrays to 25 items and reports the totals', () => {
    const { value, pruned } = prune({ data: Array.from({ length: 100 }, (_, i) => ({ i })), n: 1 });
    expect((value as { data: unknown[] }).data).toHaveLength(25);
    expect(pruned.arrays).toEqual([{ pointer: '/data', total: 100, shown: 25 }]);
  });

  it('cuts long strings, deep levels and extra nodes', () => {
    const deep = Array.from({ length: 15 }).reduce<unknown>((acc) => ({ a: acc }), 'x');
    const out = prune({ s: 'y'.repeat(600), deep });
    expect((out.value as { s: string }).s.length).toBe(501);
    expect(out.pruned).toMatchObject({ strings: 1, depthCut: true, nodesCut: false });
    const wide = prune(Object.fromEntries(Array.from({ length: 30 }, (_, i) => [`k${i}`, i])), {
      items: 25,
      string: 500,
      depth: 12,
      nodes: 10,
    });
    expect(Object.keys(wide.value as object)).toHaveLength(10);
    expect(wide.pruned.nodesCut).toBe(true);
  });

  it('leaves a small document as it is', () => {
    const doc = { a: [1, 2], b: { c: 'd' }, e: null };
    expect(prune(doc)).toEqual({
      value: doc,
      pruned: { arrays: [], strings: 0, depthCut: false, nodesCut: false },
    });
  });
});

describe('link headers', () => {
  it('reads every relation', () => {
    const header =
      '<https://x/a>; rel="prev", <https://x/b>;rel=next, <https://x/c>; rel="last first"';
    expect(linkRels(header)).toEqual({
      prev: 'https://x/a',
      next: 'https://x/b',
      last: 'https://x/c',
      first: 'https://x/c',
    });
    expect(nextFromLinkHeader(header)).toBe('https://x/b');
    expect(nextFromLinkHeader(null)).toBeNull();
  });
});

describe('detectResponse', () => {
  const members = Array.from({ length: 8 }, (_, i) => ({
    id: `m-${i}`,
    number: i,
    email: `m${i}@example.com`,
    contact: { email: `c${i}@example.com` },
    tier: i % 2 ? 'gold' : 'silver',
    updated_at: `2026-01-0${i + 1}T10:00:00Z`,
    created_at: `2025-01-0${i + 1}T10:00:00Z`,
    modified_ms: 1_767_000_000_000 + i,
    site: `https://example.com/${i}`,
  }));
  const body = { data: members, meta: { total: 40 }, notes: [{ x: 1 }] };
  const found = detectResponse({ body, headers: {}, url: 'https://api.example.com/v1/m' });

  it('finds the records array, the ID, the updated-at field and the holder email', () => {
    expect(found.records[0]).toMatchObject({
      pointer: '/data',
      jsonPath: '$.data[*]',
      count: 8,
      reason: 'name',
    });
    expect(found.id[0]).toMatchObject({ pointer: '/id', jsonPath: '$.data[*].id', unique: true });
    expect(found.updatedAt[0]).toMatchObject({ pointer: '/updated_at', format: 'iso' });
    expect(found.updatedAt.find((u) => u.pointer === '/modified_ms')?.format).toBe('unix-ms');
    expect(found.holderEmail.map((h) => h.pointer)).toEqual(['/email', '/contact/email']);
  });

  it('describes the fields, with option values for a few distinct strings', () => {
    const tier = found.fields.find((f) => f.pointer === '/tier');
    expect(tier).toMatchObject({ type: 'text', jsonPath: '$.data[*].tier' });
    expect(tier?.values).toEqual([
      { value: 'silver', count: 4 },
      { value: 'gold', count: 4 },
    ]);
    expect(found.fields.find((f) => f.pointer === '/site')?.type).toBe('url');
    expect(found.fields.find((f) => f.pointer === '/id')?.values).toBeUndefined();
  });

  it('every part passes the contract', () => {
    expect(ProbeDetectionsSchema.safeParse(found).success).toBe(true);
  });

  it('a picked array leads, even a deep one', () => {
    const deep = { a: { b: { c: { d: [{ k: 1 }, { k: 2 }] } } }, list: members };
    const out = detectResponse({
      body: deep,
      headers: {},
      url: 'https://x.test/',
      recordsPointer: '/a/b/c/d',
    });
    expect(out.records[0]).toMatchObject({ pointer: '/a/b/c/d', count: 2 });
    expect(out.id).toEqual([
      { pointer: '/k', jsonPath: '$.a.b.c.d[*].k', unique: true, score: 0.3 },
    ]);
    expect(out.fields.map((f) => f.pointer)).toEqual(['/k']);
  });

  it('a root array is "root"', () => {
    const out = detectResponse({ body: members, headers: {}, url: 'https://x.test/' });
    expect(out.records[0]).toMatchObject({ pointer: '', jsonPath: '$[*]', reason: 'root' });
  });

  it('a single record gives its fields and no pagination', () => {
    const out = detectResponse({
      body: { data: members[0] },
      headers: {},
      url: 'https://x.test/m/1',
      record: '/data',
    });
    expect(out.records).toEqual([]);
    expect(out.pagination).toEqual([]);
    expect(out.id[0]?.pointer).toBe('/id');
    expect(out.holderEmail[0]?.pointer).toBe('/email');
  });

  it('a non-unique ID-named field is reported as such', () => {
    const out = detectResponse({
      body: [{ id: 'a' }, { id: 'a' }],
      headers: {},
      url: 'https://x.test/',
    });
    expect(out.id).toEqual([{ pointer: '/id', jsonPath: '$[*].id', unique: false, score: 0.2 }]);
  });

  it('nothing to find is empty, not an error', () => {
    const out = detectResponse({ body: { ok: true }, headers: {}, url: 'https://x.test/' });
    expect(out).toMatchObject({
      records: [],
      id: [],
      updatedAt: [],
      holderEmail: [],
      fields: [],
      rateLimit: null,
    });
  });
});

describe('detectRateLimit', () => {
  it('reads limit, remaining and window from the usual headers', () => {
    expect(
      detectRateLimit({
        'ratelimit-limit': '100',
        'ratelimit-remaining': '98',
        'ratelimit-policy': '100;w=60',
      }),
    ).toEqual({ limit: 100, windowSeconds: 60, remaining: 98 });
    expect(detectRateLimit({ 'x-ratelimit-limit': '5000' })).toEqual({ limit: 5000 });
    expect(detectRateLimit({ 'content-type': 'application/json' })).toBeNull();
  });
});
