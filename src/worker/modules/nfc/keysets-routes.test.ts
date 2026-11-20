import { beforeAll, describe, expect, it } from 'vitest';
import { keysetFixture } from './keysets-test-fixtures.ts';

let f: Awaited<ReturnType<typeof keysetFixture>>;
beforeAll(async () => {
  f = await keysetFixture();
});

const json = async (r: Response) => (await r.json()) as Record<string, unknown> & { code?: string };
const HEX = /[0-9a-f]{32}/;
const NEW = { name: 'Staff badges', generate: true };

async function made(t: Awaited<ReturnType<typeof f.org>>, mode: 'live' | 'test' = 'live') {
  const r = await f.call(t.admin.headers, 'POST', `/keysets?orgId=${t.org.id}`, NEW, mode);
  expect(r.status).toBe(201);
  return json(r) as Promise<{
    id: string;
    keys: { metaKey: string; fileKey: string };
    versions: { version: number; state: string }[];
  }>;
}

describe('keyset routes', () => {
  it('creates with the keys once; a list and every later answer carry none', async () => {
    const t = await f.org();
    const created = await made(t);
    expect(created.keys.metaKey).toMatch(/^[0-9a-f]{32}$/);
    const list = await f.call(t.admin.headers, 'GET', `/keysets?orgId=${t.org.id}`);
    expect(list.status).toBe(200);
    const text = await list.text();
    expect(text).not.toMatch(HEX);
    expect(text).not.toContain('"keys"');
    expect(JSON.parse(text).items).toHaveLength(1);
    for (const [method, path, body] of [
      ['POST', `/keysets/${created.id}/disable`, undefined],
    ] as const) {
      const r = await f.call(t.admin.headers, method, path, body);
      expect(r.status).toBe(200);
      expect(await r.text()).not.toMatch(HEX);
    }
  });

  it('rotates (keys shown once), retires and disables', async () => {
    const t = await f.org();
    const created = await made(t);
    const rotated = await f.call(t.admin.headers, 'POST', `/keysets/${created.id}/rotate`, {
      generate: true,
    });
    expect(rotated.status).toBe(200);
    const body = (await json(rotated)) as { keys: { metaKey: string } };
    expect(body.keys.metaKey).toMatch(/^[0-9a-f]{32}$/);
    expect(body.keys.metaKey).not.toBe(created.keys.metaKey);
    const again = await f.call(t.admin.headers, 'POST', `/keysets/${created.id}/rotate`, {
      generate: true,
    });
    expect([again.status, (await json(again)).code]).toEqual([409, 'KEYSET_RETIRE_FIRST']);
    const retired = await f.call(t.admin.headers, 'POST', `/keysets/${created.id}/keys/1/retire`);
    expect(retired.status).toBe(200);
    const view = (await json(retired)) as { versions: { version: number; state: string }[] };
    expect(view.versions.map((v) => v.state)).toEqual(['retired', 'active']);
    const disabled = await f.call(t.admin.headers, 'POST', `/keysets/${created.id}/disable`);
    expect(((await json(disabled)) as { disabledAt: number }).disabledAt).toBeGreaterThan(0);
  });

  it('checks the body, the limit and the scope', async () => {
    const t = await f.org();
    const bad = await f.call(t.admin.headers, 'POST', `/keysets?orgId=${t.org.id}`, {
      name: 'X',
      metaKey: 'abc',
      fileKey: 'def',
    });
    expect(bad.status).toBe(422);
    for (let i = 0; i < 4; i++) await made(t);
    const fifth = await f.call(t.admin.headers, 'POST', `/keysets?orgId=${t.org.id}`, NEW);
    expect([fifth.status, (await json(fifth)).code]).toEqual([409, 'KEYSET_LIMIT']);
    // Test mode has its own four.
    await made(t, 'test');
  });

  it('lists for scanning:read, writes only for scanning:manage', async () => {
    const t = await f.org();
    const created = await made(t);
    expect((await f.call(t.operator.headers, 'GET', `/keysets?orgId=${t.org.id}`)).status).toBe(
      200,
    );
    for (const [method, path, body] of [
      ['POST', `/keysets?orgId=${t.org.id}`, NEW],
      ['POST', `/keysets/${created.id}/rotate`, { generate: true }],
      ['POST', `/keysets/${created.id}/keys/1/retire`, undefined],
      ['POST', `/keysets/${created.id}/disable`, undefined],
    ] as const)
      expect((await f.call(t.operator.headers, method, path, body)).status, path).toBe(403);
    expect((await f.call({}, 'GET', `/keysets?orgId=${t.org.id}`)).status).toBe(401);
  });

  it('shows nothing of another org or another mode', async () => {
    const a = await f.org();
    const b = await f.org();
    const created = await made(a);
    expect((await f.call(b.admin.headers, 'GET', `/keysets?orgId=${a.org.id}`)).status).toBe(404);
    expect((await f.call(b.admin.headers, 'POST', `/keysets?orgId=${a.org.id}`, NEW)).status).toBe(
      404,
    );
    for (const [method, path, body] of [
      ['POST', `/keysets/${created.id}/rotate`, { generate: true }],
      ['POST', `/keysets/${created.id}/keys/1/retire`, undefined],
      ['POST', `/keysets/${created.id}/disable`, undefined],
    ] as const) {
      const r = await f.call(b.admin.headers, method, path, body);
      expect([r.status, (await json(r)).code], path).toEqual([404, 'KEYSET_NOT_FOUND']);
      const test = await f.call(a.admin.headers, method, path, body, 'test');
      expect([test.status, (await json(test)).code], path).toEqual([404, 'KEYSET_NOT_FOUND']);
    }
    const testList = await f.call(
      a.admin.headers,
      'GET',
      `/keysets?orgId=${a.org.id}`,
      undefined,
      'test',
    );
    expect(((await json(testList)).items as unknown[]).length).toBe(0);
    const unknown = await f.call(a.admin.headers, 'POST', '/keysets/no-such/disable');
    expect(unknown.status).toBe(404);
  });
});
