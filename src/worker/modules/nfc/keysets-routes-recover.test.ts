import { beforeAll, describe, expect, it } from 'vitest';
import { keysetFixture } from './keysets-test-fixtures.ts';

let f: Awaited<ReturnType<typeof keysetFixture>>;
beforeAll(async () => {
  f = await keysetFixture();
});

type Org = Awaited<ReturnType<typeof f.org>>;
const json = async (r: Response) => (await r.json()) as Record<string, unknown> & { code?: string };
const KEY = '00112233445566778899aabbccddeeff';
const CSV = `uid,key\n04aa0000000001,${KEY}\n`;

async function keyset(
  t: Org,
  body: object = { name: 'Badges', generate: true },
  mode: 'live' | 'test' = 'live',
) {
  const r = await f.call(t.admin.headers, 'POST', `/keysets?orgId=${t.org.id}`, body, mode);
  expect(r.status).toBe(201);
  return (await json(r)) as {
    id: string;
    perTag: boolean;
    versions: { version: number; state: string }[];
  };
}
const OWN = { name: 'Supplier', perTag: true, metaKey: 'c3'.repeat(16) };

describe('revoke, re-enrol and import routes', () => {
  it('revoke a version, re-enrol to another keyset, and import: each answers without a key', async () => {
    const t = await f.org();
    const a = await keyset(t);
    const b = await keyset(t);
    const own = await keyset(t, OWN);
    expect(own.perTag).toBe(true);
    const rotated = await f.call(t.admin.headers, 'POST', `/keysets/${a.id}/rotate`, {
      generate: true,
    });
    expect(rotated.status).toBe(200);
    const revoked = await f.call(t.admin.headers, 'POST', `/keysets/${a.id}/keys/1/revoke`);
    expect(revoked.status).toBe(200);
    const view = (await json(revoked)) as {
      versions: { state: string; revokedAt: number | null }[];
    };
    expect(view.versions.map((v) => [v.state, v.revokedAt !== null])).toEqual([
      ['retired', true],
      ['active', false],
    ]);
    const moved = await f.call(t.admin.headers, 'POST', `/keysets/${b.id}/reenrol`, {
      toKeysetId: a.id,
    });
    expect(moved.status).toBe(200);
    expect(await json(moved)).toMatchObject({ moved: 0, ownKey: 0 });
    for (const dryRun of [true, false]) {
      const out = await f.call(t.admin.headers, 'POST', `/keysets/${own.id}/import`, {
        csv: CSV,
        dryRun,
      });
      expect(out.status).toBe(200);
      const text = await out.text();
      expect(text).not.toContain(KEY);
      expect(JSON.parse(text)).toMatchObject(dryRun ? { ok: 1, added: 0 } : { ok: 1, added: 1 });
    }
    const list = await (await f.call(t.admin.headers, 'GET', `/keysets?orgId=${t.org.id}`)).text();
    expect(list).not.toContain(KEY);
  });

  it('check the body', async () => {
    const t = await f.org();
    const own = await keyset(t, OWN);
    const bad = [{ csv: CSV }, { csv: '', dryRun: true }, { csv: CSV, dryRun: true, extra: 1 }];
    for (const body of bad)
      expect(
        (await f.call(t.admin.headers, 'POST', `/keysets/${own.id}/import`, body)).status,
      ).toBe(422);
    // A file over the cap is refused as too large.
    const big = await f.call(t.admin.headers, 'POST', `/keysets/${own.id}/import`, {
      csv: 'x'.repeat(60_001),
      dryRun: true,
    });
    expect(big.status).toBe(413);
    const noHeader = await f.call(t.admin.headers, 'POST', `/keysets/${own.id}/import`, {
      csv: 'serial,secret\n1,2',
      dryRun: true,
    });
    expect([noHeader.status, (await json(noHeader)).code]).toEqual([422, 'IMPORT_HEADER']);
    const re = await f.call(t.admin.headers, 'POST', `/keysets/${own.id}/reenrol`, {
      toKeysetId: own.id,
      extra: 1,
    });
    expect(re.status).toBe(422);
  });

  it('write only for scanning:manage, and show nothing of another org or mode', async () => {
    const mine = await f.org();
    const theirs = await f.org();
    const a = await keyset(mine);
    const own = await keyset(mine, OWN);
    const calls = [
      ['POST', `/keysets/${a.id}/keys/1/revoke`, undefined],
      ['POST', `/keysets/${a.id}/reenrol`, { toKeysetId: own.id }],
      ['POST', `/keysets/${own.id}/import`, { csv: CSV, dryRun: true }],
    ] as const;
    for (const [method, path, body] of calls) {
      expect((await f.call(mine.operator.headers, method, path, body)).status, path).toBe(403);
      expect((await f.call({}, method, path, body)).status, path).toBe(401);
      const stranger = await f.call(theirs.admin.headers, method, path, body);
      expect([stranger.status, (await json(stranger)).code], path).toEqual([
        404,
        'KEYSET_NOT_FOUND',
      ]);
      const test = await f.call(mine.admin.headers, method, path, body, 'test');
      expect([test.status, (await json(test)).code], path).toEqual([404, 'KEYSET_NOT_FOUND']);
    }
    // A keyset of the other org cannot be the target either.
    const foreign = await keyset(theirs);
    const r = await f.call(mine.admin.headers, 'POST', `/keysets/${a.id}/reenrol`, {
      toKeysetId: foreign.id,
    });
    expect([r.status, (await json(r)).code]).toEqual([404, 'KEYSET_NOT_FOUND']);
  });
});
