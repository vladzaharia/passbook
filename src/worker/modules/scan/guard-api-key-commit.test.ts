import { beforeAll, describe, expect, it } from 'vitest';
import { first, run } from '../../platform/db.ts';
import { key, setupTillKit } from './guard-api-key-test-fixtures.ts';
import { beforeBatch } from './repo-action-template-read-race-test-fixtures.ts';
import type { ScanKit } from './test-kit.ts';

let t: Awaited<ReturnType<typeof setupTillKit>>;
let kit: ScanKit;
beforeAll(async () => {
  t = await setupTillKit();
  kit = t.kit;
});

/** Run a request with a change landing just before the first batch that carries `marker`. */
async function raced(
  marker: string,
  change: (db: D1Database) => Promise<unknown>,
  send: () => Promise<Response>,
) {
  const real = kit.env.DB;
  const hook = beforeBatch(real, marker, change);
  Object.assign(kit.env, { DB: hook.db });
  try {
    const res = await send();
    expect(hook.fired(), marker).toBe(true);
    return res;
  } finally {
    Object.assign(kit.env, { DB: real });
  }
}
const revokeKey = (id: string) => (db: D1Database) =>
  run(db, 'UPDATE api_keys SET revoked_at = ? WHERE id = ?', [kit.clock.now(), id]);
const shape = async (res: Response) => [res.status, await t.outcomeCode(res)];
const written = (passId: string) =>
  first(kit.env.DB, 'SELECT 1 FROM scans WHERE pass_id = ? AND state = ?', [passId, 'done']);

describe('a key that stops acting is refused where the scan commits', () => {
  it('before the request, and at the claim and the gate commit', async () => {
    const pass = await kit.scanPass(t.templateId);
    const before = await t.till();
    await revokeKey(before.apiKey.id)(kit.env.DB);
    expect(await shape(await t.call(before.headers, '/actions', t.request(pass.id)))).toEqual([
      401,
      'INVALID_API_KEY',
    ]);
    for (const marker of ['INSERT INTO scans', 'INSERT INTO scan_gates']) {
      const k = await t.till();
      const res = await raced(marker, revokeKey(k.apiKey.id), () =>
        t.call(k.headers, '/actions', t.request(pass.id)),
      );
      expect([marker, ...(await shape(res))]).toEqual([marker, 401, 'INVALID_API_KEY']);
      expect(await written(pass.id)).toBeNull();
      expect(
        await first(kit.env.DB, 'SELECT 1 FROM scan_gates WHERE pass_id = ?', [pass.id]),
      ).toBeNull();
    }
  });

  it('before the undo grant', async () => {
    const k = await t.till();
    const pass = await kit.scanPass(t.templateId);
    const done = await t.call(k.headers, '/actions', t.request(pass.id));
    const scanId = ((await done.json()) as { scanId: string }).scanId;
    const res = await raced('SET undone_by', revokeKey(k.apiKey.id), () =>
      t.call(k.headers, `/scans/${scanId}/undo`, { idempotencyKey: key() }),
    );
    expect(await shape(res)).toEqual([401, 'INVALID_API_KEY']);
    expect(await first(kit.env.DB, 'SELECT undone_by FROM scans WHERE id = ?', [scanId])).toEqual({
      undone_by: null,
    });
  });

  it('before the resolve fence: the read is masked, nothing leaks or is written', async () => {
    const k = await t.till();
    const pass = await kit.scanPass(t.templateId);
    const res = await raced('actor_ok', revokeKey(k.apiKey.id), () =>
      t.call(k.headers, '/resolve', t.read(pass.id)),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { kind: string; reason: string | null; card: unknown };
    expect([body.kind, body.reason, body.card]).toEqual(['refused', 'not_found', null]);
    expect(JSON.stringify(body)).not.toContain(pass.id);
    expect(await written(pass.id)).toBeNull();
  });

  it('before the miss grant: no miss is counted', async () => {
    const k = await t.till();
    const miss = { ...t.request('x'), input: { code: 'no-such-code', method: 'camera' } };
    const res = await raced('INSERT INTO counters', revokeKey(k.apiKey.id), () =>
      t.call(k.headers, '/actions', miss),
    );
    expect(await shape(res)).toEqual([401, 'INVALID_API_KEY']);
    expect(
      await first(
        kit.env.DB,
        "SELECT 1 FROM counters WHERE key LIKE 'scan:miss:%' AND key LIKE ?",
        [`%${k.apiKey.id}%`],
      ),
    ).toBeNull();
  });

  it('when the key expires after the guard read it', async () => {
    const pass = await kit.scanPass(t.templateId);
    const k = await t.till({ expiresAt: kit.clock.now() + 60_000 });
    // The first read batch has bound its time; the claim grant is built after the clock moved.
    const res = await raced(
      'AS authorized',
      async () => {
        kit.clock.advance(120_000);
      },
      () => t.call(k.headers, '/actions', t.request(pass.id)),
    );
    expect(await shape(res)).toEqual([401, 'INVALID_API_KEY']);
    expect(await written(pass.id)).toBeNull();
  });

  it('when the terminal is revoked between the guard and the commit', async () => {
    const pass = await kit.scanPass(t.templateId);
    const k = await t.till();
    const res = await raced(
      'INSERT INTO scan_gates',
      (db) =>
        run(db, 'UPDATE scanners SET revoked_at = ? WHERE id = ?', [
          kit.clock.now(),
          k.terminal.id,
        ]),
      () => t.call(k.headers, '/actions', t.request(pass.id)),
    );
    expect(res.status).toBe(401);
    expect(await written(pass.id)).toBeNull();
  });

  it("when the org's access changes between the guard and the commit", async () => {
    const pass = await kit.scanPass(t.templateId);
    const k = await t.till();
    const res = await raced(
      'INSERT INTO scan_gates',
      (db) =>
        run(db, 'UPDATE orgs SET access_revision = access_revision + 1 WHERE id = ?', [kit.org.id]),
      () => t.call(k.headers, '/actions', t.request(pass.id)),
    );
    expect(await shape(res)).toEqual([403, 'ORG_ACCESS_CHANGED']);
    expect(await written(pass.id)).toBeNull();
  });
});
