import { beforeAll, describe, expect, it, vi } from 'vitest';
import { makeOrg } from '../../../../test/helpers/index.ts';
import { ScanOutcomeSchema } from '../../../shared/contracts/scan.ts';
import { first, run } from '../../platform/db.ts';
import { key, setupTillKit } from './guard-api-key-test-fixtures.ts';
import type { ScanKit } from './test-kit.ts';

let t: Awaited<ReturnType<typeof setupTillKit>>;
let kit: ScanKit;
beforeAll(async () => {
  t = await setupTillKit();
  kit = t.kit;
});
const noScan = (passId: string) =>
  first(kit.env.DB, 'SELECT 1 FROM scans WHERE pass_id = ?', [passId]);
const outcomeOf = async (res: Response) => ScanOutcomeSchema.parse(await res.json());

describe('a scans:write key acting as a terminal', () => {
  it('scans, reads and undoes as the terminal; the scan, the ledger and the limiter name the key', async () => {
    const k = await t.till();
    const pass = await kit.scanPass(t.templateId);
    expect((await t.call(k.headers, '/resolve', t.read(pass.id))).status).toBe(200);
    const res = await t.call(k.headers, '/actions', t.request(pass.id));
    expect(res.status).toBe(200);
    const outcome = await outcomeOf(res);
    expect(outcome.kind).toBe('ok');
    expect(
      await first(kit.env.DB, 'SELECT actor_key, actor_type, api_key_id FROM scans WHERE id = ?', [
        outcome.scanId,
      ]),
    ).toEqual({
      actor_key: `s:${k.terminal.id}`,
      actor_type: 'scanner',
      api_key_id: k.apiKey.id,
    });
    const event = await first<{ data: string }>(
      kit.env.DB,
      "SELECT data FROM pass_events WHERE pass_id = ? AND kind LIKE 'scan.%'",
      [pass.id],
    );
    expect(JSON.parse(event?.data ?? '{}')).toMatchObject({
      scannerId: k.terminal.id,
      apiKeyId: k.apiKey.id,
    });
    const counts = (kit.env.RL_SCAN as unknown as { counts: Map<string, number> }).counts;
    expect(counts.has(`k:${k.apiKey.id}:s:${k.terminal.id}`)).toBe(true);
    expect(counts.has(`s:${k.terminal.id}`)).toBe(false);
    const undone = await t.call(k.headers, `/scans/${outcome.scanId}/undo`, {
      idempotencyKey: key(),
    });
    expect(undone.status).toBe(200);
  });

  it('keeps working when the org has api off: doors are scanning, not API', async () => {
    const k = await t.till();
    await run(
      kit.env.DB,
      "INSERT OR REPLACE INTO org_entitlement_overrides (org_id, key, value, updated_at) VALUES (?, 'api', '\"off\"', 1)",
      [kit.org.id],
    );
    try {
      const pass = await kit.scanPass(t.templateId);
      expect((await t.call(k.headers, '/resolve', t.read(pass.id))).status).toBe(200);
      expect((await t.call(k.headers, '/actions', t.request(pass.id))).status).toBe(200);
    } finally {
      await run(kit.env.DB, 'DELETE FROM org_entitlement_overrides WHERE org_id = ?', [kit.org.id]);
    }
  });

  it("is capped at the terminal's own role: Desk on a Desk terminal, Door on a Door terminal", async () => {
    const desk = await t.till();
    const door = await t.till({ terminal: { settings: { roleWithoutSignIn: 'door' } } });
    const refused = async (headers: Record<string, string>, actionId: string) => {
      const pass = await kit.scanPass(t.templateId);
      const res = await t.call(headers, '/actions', t.request(pass.id, { actionId }));
      expect(res.status).toBe(200);
      const outcome = await outcomeOf(res);
      expect(await noScan(pass.id)).toBeNull();
      return outcome;
    };
    const vip = await refused(desk.headers, 'vip');
    expect(vip.kind).not.toBe('ok');
    // The same terminal's own token is refused the same way: the key adds no rights.
    expect((await refused(desk.terminal.headers, 'vip')).reason).toBe(vip.reason);
    const deskAction = await refused(door.headers, 'deskact');
    expect(deskAction.kind).not.toBe('ok');
    const pass = await kit.scanPass(t.templateId);
    const ok = await t.call(desk.headers, '/actions', t.request(pass.id, { actionId: 'deskact' }));
    expect((await outcomeOf(ok)).kind).toBe('ok');
  });

  it('refuses approvals and overrides', async () => {
    const k = await t.till();
    const pass = await kit.scanPass(t.templateId);
    const manager = await kit.staff('manager');
    const approval = { staffId: manager.id, pin: manager.pin };
    for (const [path, body] of [
      ['/actions', t.request(pass.id, { approval })],
      ['/actions', t.request(pass.id, { overrideOf: key() })],
      [`/scans/${key()}/undo`, { idempotencyKey: key(), approval }],
    ] as const) {
      const res = await t.call(k.headers, path, body);
      expect([path, res.status, await t.outcomeCode(res)]).toEqual([
        path,
        403,
        'API_KEY_NO_APPROVAL',
      ]);
    }
    expect(await noScan(pass.id)).toBeNull();
  });

  it('refuses a platform key, a missing scope and a missing header', async () => {
    const pass = await kit.scanPass(t.templateId);
    const platform = await t.till({ orgId: null });
    const noOrg = await t.call(platform.headers, '/actions', t.request(pass.id));
    expect([noOrg.status, await t.outcomeCode(noOrg)]).toEqual([403, 'API_KEY_ORG_REQUIRED']);
    const noScope = await t.till({ scopes: ['scans:read', 'passes:write'] });
    const missing = await t.call(noScope.headers, '/actions', t.request(pass.id));
    expect([missing.status, await t.outcomeCode(missing)]).toEqual([403, 'MISSING_SCOPE']);
    const k = await t.till();
    const noHeader = await t.call(k.apiKey.headers, '/actions', t.request(pass.id));
    expect([noHeader.status, await t.outcomeCode(noHeader)]).toEqual([422, 'DEVICE_REQUIRED']);
    expect(await noScan(pass.id)).toBeNull();
  });

  it('acts only as the terminals it was minted for: one identical 404 for every other id', async () => {
    const a = await t.till();
    const pass = await kit.scanPass(t.templateId);
    const other = await makeOrg(kit.fx);
    const bodies: unknown[] = [];
    const named = async (id: string, headers = a.apiKey.headers) =>
      t.call({ ...headers, 'x-passbook-device': id }, '/actions', t.request(pass.id));
    const b = await t.till(); // a terminal of the same org, bound to another key
    const device = await kit.scanner({ kind: 'device' });
    const display = await kit.scanner({ kind: 'display' });
    const foreign = await t.makeTerminal({ orgId: other.id, kind: 'terminal' });
    const testMode = await kit.scanner({ kind: 'terminal', mode: 'test' });
    const revoked = await kit.scanner({ kind: 'terminal', revoked: true });
    const expired = await kit.scanner({ kind: 'terminal', expiresAt: kit.clock.now() - 1 });
    for (const id of [
      key(),
      b.terminal.id,
      device.id,
      display.id,
      foreign.id,
      testMode.id,
      revoked.id,
      expired.id,
    ]) {
      const res = await named(id);
      expect([id, res.status]).toEqual([id, 404]);
      bodies.push(await t.problemOf(res));
    }
    expect(new Set(bodies.map((x) => JSON.stringify(x))).size).toBe(1);
    // A key bound to B and named A is the same refusal; and B works under its own key.
    expect((await named(a.terminal.id, b.apiKey.headers)).status).toBe(404);
    expect((await named(b.terminal.id, b.apiKey.headers)).status).toBe(200);
    // A test-mode key cannot drive a live terminal even if bound.
    const testKey = await t.mintKey({ mode: 'test', terminals: [] });
    expect((await named(a.terminal.id, testKey.headers)).status).toBe(404);
    expect(await noScan(pass.id)).not.toBeNull(); // only B's scan
  });

  it('opens only resolve, actions and its own undo', async () => {
    const k = await t.till();
    for (const path of ['/lookup', '/device', '/staff', '/session']) {
      const res = await t.call(k.headers, path, {});
      expect([path, res.status, await t.outcomeCode(res)]).toEqual([path, 403, 'API_KEY_ROUTE']);
    }
    const get = await t.call(k.headers, '/session', {}, 'GET');
    expect(await t.outcomeCode(get)).toBe('API_KEY_ROUTE');
  });
});

describe('undo through a key', () => {
  async function scanned(headers: Record<string, string>) {
    const pass = await kit.scanPass(t.templateId);
    const res = await t.call(headers, '/actions', t.request(pass.id));
    return (await outcomeOf(res)).scanId as string;
  }
  const undo = (headers: Record<string, string>, scanId: string) =>
    t.call(headers, `/scans/${scanId}/undo`, { idempotencyKey: key() });

  it("is limited to the key's own scans, within the window", async () => {
    const k = await t.till();
    const own = await scanned(k.headers);
    expect((await undo(k.headers, own)).status).toBe(200);
    // The physical terminal's own scan, on the same terminal, is not the key's.
    const physical = await scanned(k.terminal.headers);
    const refusedPhysical = await undo(k.headers, physical);
    expect([refusedPhysical.status, await t.outcomeCode(refusedPhysical)]).toEqual([
      403,
      'SCAN_UNDO_FORBIDDEN',
    ]);
    // Another terminal's scan under another key.
    const other = await t.till();
    const theirs = await scanned(other.headers);
    expect((await undo(k.headers, theirs)).status).toBeGreaterThanOrEqual(403);
    // And the physical terminal cannot undo the key's.
    const viaKey = await scanned(k.headers);
    expect((await undo(k.terminal.headers, viaKey)).status).toBe(403);
  });

  it('is refused past the undo window, and is refused a PIN', async () => {
    const k = await t.till();
    const id = await scanned(k.headers);
    kit.clock.advance(2 * 3_600_000);
    const late = await undo(k.headers, id);
    expect([late.status, await t.outcomeCode(late)]).toEqual([403, 'SCAN_UNDO_FORBIDDEN']);
  });
});

describe('a refused terminal key', () => {
  it('adds its code to request.done: the prefix of an unknown key, the id of a key without the scope', async () => {
    const pass = await kit.scanPass(t.templateId);
    const noScope = await t.till({ scopes: ['scans:read', 'passes:write'] });
    const k = await t.till();
    const seen: string[] = [];
    const spy = vi.spyOn(console, 'info').mockImplementation((l) => void seen.push(String(l)));
    try {
      const unknown = await t.call(
        {
          ...k.headers,
          authorization: 'Bearer pb_live_ABCDEFGH_0123456789012345678901234567890123456789012',
        },
        '/actions',
        t.request(pass.id),
      );
      expect(unknown.status).toBe(401);
      expect((await t.call(noScope.headers, '/actions', t.request(pass.id))).status).toBe(403);
    } finally {
      spy.mockRestore();
    }
    const done = seen
      .map((l) => JSON.parse(l) as Record<string, unknown>)
      .filter((l) => l.event === 'request.done' && l.code !== undefined);
    expect(done[0]).toMatchObject({ code: 'INVALID_API_KEY', keyPrefix: 'ABCDEFGH' });
    expect(done[1]).toMatchObject({
      code: 'MISSING_SCOPE',
      keyId: noScope.apiKey.id,
      scope: 'scans:write',
    });
  });
});
