import { describe, expect, it } from 'vitest';
import { installKeysetTestEnv } from '../../../../test/helpers/credential-keyset.ts';
import { makeOrg, makeScanner } from '../../../../test/helpers/index.ts';
import { ScanSessionSchema } from '../../../shared/contracts/scan-session.ts';
import {
  ScanningSessionDetailSchema,
  ScanningSessionListSchema,
} from '../../../shared/contracts/scanning-sessions.ts';
import { run } from '../../platform/db.ts';
import { scannerActor, scanScannerCsrfProof, withRole } from './actor.ts';
import { DEFAULT_SETTINGS } from './dto-console.ts';
import { getScanner } from './repo-device.ts';
import { scanningSessionStats } from './repo-scanning-sessions.ts';
import { readScannerScope } from './repo-scope.ts';
import {
  atCountBatch,
  freshFixture,
  insertExistingReference,
  seedSessionListStats,
  singleton,
  withMutableScannerSecret,
} from './repo-session-stats-authority-test-fixtures.ts';
import { bindScanningSession, scanSessionCountAuthority } from './scanning-workspace.ts';
import { grantScanMembership } from './test-kit.ts';
import { captureTestEpochs } from './test-kit-epochs.ts';

const makeEnv = installKeysetTestEnv();

describe('scanning session count authority', () => {
  it('leaves device CRUD and an authorized fresh-tenant list without a credential keyset', async () => {
    const f = await freshFixture(await makeEnv());
    expect(await singleton(f)).toBeNull();
    const created = await f.request(`/scanning-sessions/${f.id}/devices`, f.browser.headers, {
      method: 'POST',
      body: JSON.stringify({ name: 'Front desk', surface: 'phone' }),
    });
    expect(created.status).toBe(201);
    const device = (await created.json()) as { id: string };
    expect(await singleton(f)).toBeNull();
    const updated = await f.request(
      `/scanning-sessions/${f.id}/devices/${device.id}`,
      f.browser.headers,
      {
        method: 'PATCH',
        body: JSON.stringify({ name: 'Renamed desk' }),
      },
    );
    expect(updated.status).toBe(200);
    expect(await singleton(f)).toBeNull();
    const list = await f.request(`/scanning-sessions?orgId=${f.org.id}`);
    expect(list.status).toBe(200);
    expect(ScanningSessionListSchema.parse(await list.json()).items).toMatchObject([
      { id: f.id, orgId: f.org.id, mode: 'live', today: 0, deviceCount: 1, onlineCount: 0 },
    ]);
    // Reads do not initialize the credential keyset any more.
    expect(await singleton(f)).toBeNull();
    const detail = await f.request(`/scanning-sessions/${f.id}`);
    expect(detail.status).toBe(200);
    expect(ScanningSessionDetailSchema.parse(await detail.json())).toMatchObject({
      id: f.id,
      today: 0,
    });
  });

  it('merges paginated results using each original tenant read authority', async () => {
    const f = await freshFixture(await makeEnv());
    const other = await makeOrg(f.fx);
    const denied = await makeOrg(f.fx);
    await grantScanMembership(f.fx, other.id, f.user.id, ['read_only']);
    const otherId = f.fx.ids.id();
    const deniedId = f.fx.ids.id();
    for (const [id, org] of [
      [otherId, other.id],
      [deniedId, denied.id],
    ]) {
      await run(
        f.env.DB,
        `INSERT INTO scanning_sessions
        (id,org_id,mode,name,status,accepts,settings,time_zone,created_at,updated_at)
        VALUES (?,?,'live','Other session','active',NULL,?,'UTC',?,?)`,
        [id, org, JSON.stringify(DEFAULT_SETTINGS), f.clock.now(), f.clock.now()],
      );
    }
    const firstPage = await f.request('/scanning-sessions?limit=1');
    expect(firstPage.status).toBe(200);
    const page = ScanningSessionListSchema.parse(await firstPage.json());
    expect(page.items).toHaveLength(1);
    expect(page.nextCursor).not.toBeNull();
    const secondPage = await f.request(
      `/scanning-sessions?limit=1&cursor=${encodeURIComponent(page.nextCursor!)}`,
    );
    expect(secondPage.status).toBe(200);
    const next = ScanningSessionListSchema.parse(await secondPage.json());
    expect(next.nextCursor).toBeNull();
    expect([...page.items, ...next.items].map((item) => item.id)).toEqual(
      [f.id, otherId].sort().reverse(),
    );
    expect([...page.items, ...next.items].map((item) => item.orgId)).toEqual(
      expect.arrayContaining([f.org.id, other.id]),
    );
  });

  it('lists exact scoped session metrics and excludes private ledger rows at page size 50', async () => {
    const f = await freshFixture(await makeEnv());
    const seeded = await seedSessionListStats(f);
    const path = `/scanning-sessions?orgId=${f.org.id}&limit=50`;
    const response = await f.request(path);
    expect(response.status).toBe(200);
    const raw = await response.json();
    const page = ScanningSessionListSchema.parse(raw);
    const metrics = (items: typeof page.items) =>
      Object.fromEntries(
        items.map(({ id, orgId, mode, deviceCount, onlineCount, today }) => [
          id,
          [orgId, mode, deviceCount, onlineCount, today],
        ]),
      );
    expect(page.nextCursor).toBeNull();
    expect(metrics(page.items)).toEqual({
      [f.id]: [f.org.id, 'live', 4, 2, 3],
      [seeded.second]: [f.org.id, 'live', 1, 1, 2],
      [seeded.empty]: [f.org.id, 'live', 0, 0, 0],
    });
    for (const privateId of seeded.privateIds) expect(JSON.stringify(raw)).not.toContain(privateId);
    const all = await f.request('/scanning-sessions?limit=50');
    expect(all.status).toBe(200);
    expect(metrics(ScanningSessionListSchema.parse(await all.json()).items)).toEqual(
      metrics(page.items),
    );
    const testHeaders = { ...f.browser.headers, 'x-passbook-mode': 'test' };
    const test = await f.request(path, testHeaders);
    expect(test.status).toBe(200);
    const testPage = ScanningSessionListSchema.parse(await test.json());
    expect(metrics(testPage.items)).toEqual({
      [seeded.test]: [f.org.id, 'test', 1, 1, 1],
    });
    for (const item of [...page.items, ...testPage.items]) {
      const detail = await f.request(
        `/scanning-sessions/${item.id}`,
        item.mode === 'test' ? testHeaders : f.browser.headers,
      );
      expect(detail.status).toBe(200);
      expect(metrics([ScanningSessionDetailSchema.parse(await detail.json())])).toEqual(
        metrics([item]),
      );
    }
    const denied = await f.request(`/scanning-sessions?orgId=${seeded.foreignOrgId}&limit=50`);
    expect(denied.status).toBe(403);
    expect(await denied.text()).not.toContain(seeded.denied);
    const emptyOrg = await makeOrg(f.fx);
    await grantScanMembership(f.fx, emptyOrg.id, f.user.id, ['read_only']);
    const empty = await f.request(`/scanning-sessions?orgId=${emptyOrg.id}&limit=50`);
    expect(empty.status).toBe(200);
    expect(await empty.json()).toEqual({ items: [], nextCursor: null });
  });

  it('returns the unchanged workspace DTO and fresh scoped counts to an authorized device', async () => {
    const f = await freshFixture(await makeEnv());
    const scanner = await makeScanner(f.fx, { orgId: f.org.id });
    await run(
      f.env.DB,
      `INSERT INTO scanning_devices (scanner_id,session_id,org_id,mode)
      VALUES (?,?,?,'live')`,
      [scanner.id, f.id, f.org.id],
    );
    expect(await singleton(f)).toBeNull();
    const response = await f.request('/scan/session', scanner.headers);
    expect(response.status).toBe(200);
    expect(ScanSessionSchema.parse(await response.json()).workspace).toMatchObject({
      session: {
        id: f.id,
        orgId: f.org.id,
        mode: 'live',
        today: 0,
        deviceCount: 1,
        onlineCount: 1,
      },
      device: { id: scanner.id, sessionId: f.id, signIn: 'paired' },
    });
    expect(await singleton(f)).toBeNull();
  });

  it.each(['missing with references', 'mismatched commitment'] as const)(
    'serves an authorized device when the keyset is %s',
    async (condition) => {
      const f = await freshFixture(await makeEnv());
      const scanner = await makeScanner(f.fx, { orgId: f.org.id });
      await run(
        f.env.DB,
        `INSERT INTO scanning_devices (scanner_id,session_id,org_id,mode)
        VALUES (?,?,?,'live')`,
        [scanner.id, f.id, f.org.id],
      );
      const other =
        f.proof.credentialKeysetCommitment === '0'.repeat(64) ? '1'.repeat(64) : '0'.repeat(64);
      if (condition === 'missing with references') await insertExistingReference(f);
      else
        await run(f.env.DB, 'INSERT INTO credential_ref_keyset (id,commitment) VALUES (1,?)', [
          other,
        ]);
      // Counts are plain reads: a missing or different keyset does not make the workspace unavailable.
      const response = await f.request('/scan/session', scanner.headers);
      expect(response.status).toBe(200);
      expect(ScanSessionSchema.parse(await response.json()).workspace).toMatchObject({
        session: { id: f.id },
      });
      expect(await singleton(f)).toEqual(
        condition === 'missing with references' ? null : { commitment: other },
      );
    },
  );

  it.each(['revoked', 'csrf'] as const)(
    'finds no session for a %s device at the workspace counts batch',
    async (change) => {
      const f = await freshFixture(await makeEnv());
      const scanner = await makeScanner(f.fx, { orgId: f.org.id });
      await run(
        f.env.DB,
        `INSERT INTO scanning_devices (scanner_id,session_id,org_id,mode)
        VALUES (?,?,?,'live')`,
        [scanner.id, f.id, f.org.id],
      );
      const secret = scanner.headers['x-csrf-token'];
      if (!secret) throw new Error('Missing scanner CSRF secret');
      const race = () =>
        atCountBatch(
          f.env,
          () => f.request('/scan/session', scanner.headers),
          async (db) => {
            if (change === 'revoked')
              await run(db, 'UPDATE scanners SET revoked_at=? WHERE id=?', [
                f.clock.now(),
                scanner.id,
              ]);
            else
              await run(db, 'UPDATE scanners SET csrf_secret=? WHERE id=?', [
                'replacement-device-secret',
                scanner.id,
              ]);
          },
        );
      const { result } =
        change === 'csrf'
          ? await withMutableScannerSecret(f.env.DB, scanner.id, secret, race)
          : await race();
      // The counts batch finds no session for a device whose credential moved: not found, no counts.
      expect(result.status).toBe(404);
      expect(await result.json()).toMatchObject({ code: 'SCANNING_SESSION_NOT_FOUND' });
      expect(await singleton(f)).toBeNull();
    },
  );

  it.each(['csrf', 'revoked', 'binding mode'] as const)(
    'fences the original device %s before initializing or counting',
    async (change) => {
      const f = await freshFixture(await makeEnv());
      const scanner = await makeScanner(f.fx, { orgId: f.org.id });
      await run(
        f.env.DB,
        `INSERT INTO scanning_devices (scanner_id,session_id,org_id,mode)
        VALUES (?,?,?,'live')`,
        [scanner.id, f.id, f.org.id],
      );
      const row = await getScanner(f.env.DB, scanner.id);
      const secret = scanner.headers['x-csrf-token'];
      if (!row || !secret) throw new Error('Missing device credential');
      const scope = await readScannerScope(f.env.DB, row, null);
      const actor = scannerActor(f.ctx, { ...row, csrfSecret: null }, row.mode, 'cookie', scope);
      await bindScanningSession(f.ctx, actor);
      withRole(actor, null);
      actor.scannerCsrfProof = await scanScannerCsrfProof(f.env, scanner.id, secret);
      await captureTestEpochs(f.ctx, actor);
      const authority = await scanSessionCountAuthority(f.ctx, actor);
      expect(authority.sessionId).toBe(f.id);
      const race = () =>
        atCountBatch(
          f.env,
          () =>
            scanningSessionStats(
              f.env.DB,
              f.row,
              f.clock.now() - 86_400_000,
              f.clock.now() - 120_000,
              authority,
              f.clock.now(),
            ),
          async (db) => {
            if (change === 'csrf')
              await run(db, 'UPDATE scanners SET csrf_secret=? WHERE id=?', [
                'replacement-device-secret',
                scanner.id,
              ]);
            if (change === 'revoked')
              await run(db, 'UPDATE scanners SET revoked_at=? WHERE id=?', [
                f.clock.now(),
                scanner.id,
              ]);
            if (change === 'binding mode')
              await run(db, "UPDATE scanning_devices SET mode='test' WHERE scanner_id=?", [
                scanner.id,
              ]);
          },
        );
      const { result } =
        change === 'csrf'
          ? await withMutableScannerSecret(f.env.DB, scanner.id, secret, race)
          : await race();
      expect(result).toBeNull();
      expect(await singleton(f)).toBeNull();
    },
  );
});
