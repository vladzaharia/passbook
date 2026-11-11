import { describe, expect, it } from 'vitest';
import { makeOrg, makeScanner, makeSession, makeUser } from '../../../../test/helpers/index.ts';
import { first, run } from '../../platform/db.ts';
import {
  clock,
  DAY,
  env,
  f,
  get,
  items,
  ORIGIN,
  orgId,
  passId,
  post,
  recordedAction,
  recordedNoMatch,
  scannerFixture,
  scannerId,
  seed,
  userHeaders,
} from './repo-scans-split-test-fixtures.ts';
import { grantScanMembership } from './test-kit.ts';

describe('scan log tenant authorization', () => {
  const undoKey = '018f0000-0000-7000-8000-000000000090';
  const exportFor = (id: string) =>
    `/export?orgId=${id}&from=${clock.now() - DAY}&to=${clock.now() + DAY}`;

  it.each(['org_admin', 'read_only', 'pass_operator'] as const)(
    'allows a non-platform %s to list, read and export its own scans',
    async (role) => {
      const row = await recordedAction(scannerFixture, passId);
      const user = await makeUser(f);
      await grantScanMembership(f, orgId, user.id, [role]);
      const headers = { ...(await makeSession(f, { userId: user.id })).headers, origin: ORIGIN };
      const list = await get(`?orgId=${orgId}`, headers);
      expect(list.status).toBe(200);
      expect((await items(list)).map((item) => item.id)).toEqual([row.id]);
      expect((await get(`/${row.id}`, headers)).status).toBe(200);
      const csv = await get(exportFor(orgId), headers);
      expect(csv.status).toBe(200);
      expect(await csv.text()).toContain('Alex Morgan');
    },
  );

  it('does not let a platform admin without membership read, export or undo an organization scan', async () => {
    const row = await seed();
    const platformAdmin = await makeUser(f);
    const headers: Record<string, string> = {
      ...(await makeSession(f, { userId: platformAdmin.id, roles: ['admin', 'user'] })).headers,
      origin: ORIGIN,
    };
    const list = await get(`?orgId=${orgId}`, headers);
    expect(list.status).toBe(200);
    expect(await items(list)).toEqual([]);
    expect((await get(`/${row.id}`, headers)).status).toBe(404);
    expect((await get(exportFor(orgId), headers)).status).toBe(404);
    expect((await post(`/${row.id}/undo`, { idempotencyKey: undoKey }, headers)).status).toBe(404);
    expect(
      await first(env.DB, "SELECT id FROM audit_log WHERE action IN ('scan.export', 'scan.undo')"),
    ).toBeNull();
  });

  it('requires an org for session lists and masks scans belonging to another organization', async () => {
    const own = await seed();
    const other = await makeOrg(f);
    const foreignScanner = await makeScanner(f, {
      orgId: other.id,
      settings: { acceptAllTemplates: true },
    });
    const foreign = await recordedNoMatch(foreignScanner);
    const foreignUser = await makeUser(f);
    await grantScanMembership(f, other.id, foreignUser.id, ['read_only']);
    const foreignHeaders = {
      ...(await makeSession(f, { userId: foreignUser.id })).headers,
      origin: ORIGIN,
    };
    const foreignList = await get(`?orgId=${other.id}`, foreignHeaders);
    expect(foreignList.status).toBe(200);
    expect((await items(foreignList)).map((item) => item.id)).toEqual([foreign.id]);
    expect((await get(`/${foreign.id}`, foreignHeaders)).status).toBe(200);
    expect((await get('')).status).toBe(422);
    expect((await get(`?scannerId=${scannerId}`)).status).toBe(422);
    expect((await items(await get(`?orgId=${orgId}`))).map((item) => item.id)).toEqual([own.id]);
    const list = await get(`?orgId=${other.id}`);
    expect(list.status).toBe(200);
    expect(await items(list)).toEqual([]);
    expect((await get(`/${foreign.id}`)).status).toBe(404);
    expect((await get(exportFor(other.id))).status).toBe(404);
    expect((await post(`/${foreign.id}/undo`, { idempotencyKey: undoKey })).status).toBe(404);
  });

  it('rejects a same-org member whose role does not grant scanning access', async () => {
    const row = await seed();
    expect((await get(`?orgId=${orgId}`, userHeaders)).status).toBe(403);
    expect((await get(`/${row.id}`, userHeaders)).status).toBe(403);
    expect((await get(exportFor(orgId), userHeaders)).status).toBe(403);
    expect((await post(`/${row.id}/undo`, { idempotencyKey: undoKey }, userHeaders)).status).toBe(
      403,
    );
  });

  it('rechecks membership after revocation and uses the replacement role on the next request', async () => {
    const row = await seed();
    const user = await makeUser(f);
    const membership = await grantScanMembership(f, orgId, user.id);
    const headers: Record<string, string> = {
      ...(await makeSession(f, { userId: user.id, roles: ['admin', 'user'] })).headers,
      origin: ORIGIN,
    };
    expect((await get(`/${row.id}`, headers)).status).toBe(200);
    await run(env.DB, 'UPDATE org_memberships SET revoked_at = ? WHERE id = ?', [
      clock.now(),
      membership,
    ]);
    expect(await items(await get(`?orgId=${orgId}`, headers))).toEqual([]);
    expect((await get(`/${row.id}`, headers)).status).toBe(404);
    expect((await get(exportFor(orgId), headers)).status).toBe(404);
    expect((await post(`/${row.id}/undo`, { idempotencyKey: undoKey }, headers)).status).toBe(404);
    await grantScanMembership(f, orgId, user.id, ['read_only']);
    expect((await get(`/${row.id}`, headers)).status).toBe(200);
    expect((await post(`/${row.id}/undo`, { idempotencyKey: undoKey }, headers)).status).toBe(403);
  });

  it('lets a read-only member read but not undo a scan', async () => {
    const row = await seed();
    const user = await makeUser(f);
    await grantScanMembership(f, orgId, user.id, ['read_only']);
    const headers: Record<string, string> = {
      ...(await makeSession(f, { userId: user.id })).headers,
      origin: ORIGIN,
    };
    expect((await get(`/${row.id}`, headers)).status).toBe(200);
    expect((await post(`/${row.id}/undo`, { idempotencyKey: undoKey }, headers)).status).toBe(403);
  });
});
