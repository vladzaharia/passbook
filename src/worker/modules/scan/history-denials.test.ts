import { describe, expect, it } from 'vitest';
import { makeOrg, makeSession, makeUser, withoutTrigger } from '../../../../test/helpers/index.ts';
import { read } from '../../platform/counters.ts';
import { first, run } from '../../platform/db.ts';
import { createSessionStore } from '../auth/sessions.ts';
import { ensureCredentialRefKeyset } from '../passes/credential-keyset.ts';
import { tenantAuthorityOf } from '../passes/http.ts';
import { beforeBatch, beforeStatement } from './batch-interceptor-test-support.ts';
import { recordedCheckIn } from './console-privacy-actions-test-fixtures.ts';
import {
  admin,
  adminMembershipId,
  adminUserId,
  app,
  expectNoSecrets,
  exportPath,
  fake,
  get,
  kit,
  PUBLIC,
  privatePass,
  setupPrivacyKit,
  templateId,
  testAdmin,
} from './console-privacy-test-fixtures.ts';
import { captureConsoleFeed, recordPage } from './feed-console-page.ts';
import { createHistoryEvidenceCache } from './history-row-evidence.ts';
import { RACE_EXPORT_COUNT, RACE_HISTORY_PAGE, RACE_STAFF_STARTS } from './race-tags.ts';
import { listScanRows } from './repo-feed.ts';
import { apiKeyReadAuthority, scanReadFence } from './repo-read-authority.ts';
import { grantScanMembership, ORIGIN } from './test-kit.ts';

setupPrivacyKit();

/*
 * The denial matrix of the ledger reads that sit on the history page statement: a console list,
 * detail, export and staff roster, and the API-key feed. Each denial has a positive control that
 * shows the same read succeeding, so a refusal is the denial and not a broken fixture.
 */

const staffList = (headers = admin) =>
  Promise.resolve(
    app.request(`${ORIGIN}/api/v1/scan-staff?orgId=${kit.org.id}`, { headers }, kit.env),
  );

async function recorded() {
  const scanner = await kit.scanner({ templateIds: [templateId] });
  const pass = await privatePass();
  const row = await recordedCheckIn(scanner, pass.id);
  return { scanner, pass, row };
}

async function otherOrgAdmin() {
  const org = await makeOrg(kit.fx);
  const user = await makeUser(kit.fx);
  await grantScanMembership(kit.fx, org.id, user.id);
  const session = await makeSession(kit.fx, { userId: user.id, roles: ['admin', 'user'] });
  return { org, headers: { ...session.headers, origin: ORIGIN } };
}

const revokeMembership = (db: D1Database) =>
  run(db, 'UPDATE org_memberships SET revoked_at = ? WHERE id = ?', [
    kit.clock.now(),
    adminMembershipId,
  ]);

describe('another organization and the other mode', () => {
  it("shows an organization its own history only, and never another organization's scan", async () => {
    const { pass, row } = await recorded();
    const other = await otherOrgAdmin();
    // Positive control: the owner sees its scan with the pass.
    const own = await get(`?orgId=${kit.org.id}`);
    expect(await own.text()).toContain(pass.id);
    const foreignList = await get(`?orgId=${kit.org.id}`, other.headers);
    expect(foreignList.status).toBe(200);
    expect(await foreignList.json()).toEqual({ items: [], nextCursor: null });
    const mine = await get(`?orgId=${other.org.id}`, other.headers);
    expect(await mine.json()).toEqual({ items: [], nextCursor: null });
    expect((await get(`/${row.id}`, other.headers)).status).toBe(404);
    expect((await get(exportPath(), other.headers)).status).toBe(404);
    const roster = await staffList(other.headers);
    expect(roster.status).toBe(200);
    expect(JSON.stringify(await roster.json())).not.toContain(pass.id);
  });

  it('keeps a Test scan out of Live reads and a Live scan out of Test reads', async () => {
    const live = await recorded();
    const scanner = await kit.scanner({ templateIds: [templateId], mode: 'test' });
    const testPass = await kit.scanPass(templateId, { memberName: PUBLIC }, { mode: 'test' });
    const testRow = await recordedCheckIn(scanner, testPass.id);
    const inLive = await get(`?orgId=${kit.org.id}`);
    const liveIds = ((await inLive.json()) as { items: { id: string }[] }).items.map((i) => i.id);
    expect(liveIds).toEqual([live.row.id]);
    expect((await get(`/${testRow.id}`)).status).toBe(404);
    const inTest = await get(`?orgId=${kit.org.id}`, testAdmin);
    const testIds = ((await inTest.json()) as { items: { id: string }[] }).items.map((i) => i.id);
    expect(testIds).toEqual([testRow.id]);
    expect((await get(`/${live.row.id}`, testAdmin)).status).toBe(404);
    const key = fake.apiKey({ orgId: kit.org.id, scopes: ['scans:read'], mode: 'test' });
    const keyed = ((await (await get('', key)).json()) as { items: { id: string }[] }).items;
    expect(keyed.map((item) => item.id)).toEqual([testRow.id]);
  });
});

describe('membership revoked before the page statement', () => {
  it.each([
    ['list', `?orgId=${'ORG'}`, 403],
    ['export', 'EXPORT', 403],
  ] as const)('refuses a %s, naming nothing', async (surface, path, status) => {
    const { pass, row } = await recorded();
    const target = path === 'EXPORT' ? exportPath() : path.replace('ORG', kit.org.id);
    // Positive control: the same read answers while the membership holds.
    expect(await (await get(target)).text()).toContain(surface === 'list' ? pass.id : PUBLIC);
    const { result: response, fired } = await beforeBatch(
      kit.env,
      surface === 'list' ? RACE_HISTORY_PAGE : RACE_EXPORT_COUNT,
      revokeMembership,
      async () => {
        const res = await get(target);
        return { status: res.status, text: await res.text() };
      },
    );
    expect(fired).toBe(true);
    expect(response.status).toBe(status);
    expect(response.text).not.toContain(row.id);
    expectNoSecrets(response.text, pass);
  });

  it('answers a detail with not found', async () => {
    const { pass, row } = await recorded();
    expect((await get(`/${row.id}`)).status).toBe(200);
    const { result, fired } = await beforeBatch(
      kit.env,
      RACE_HISTORY_PAGE,
      revokeMembership,
      async () => {
        const res = await get(`/${row.id}`);
        return { status: res.status, text: await res.text() };
      },
    );
    expect(fired).toBe(true);
    expect(result.status).toBe(404);
    expect(result.text).not.toContain(pass.id);
  });

  it('lists no staff, and no scanner name', async () => {
    const staff = await kit.staff('manager');
    const scanner = await kit.scanner({
      templateIds: [templateId],
      staffId: staff.id,
      settings: { staffSignIn: true },
    });
    await recordedCheckIn(scanner, (await privatePass()).id);
    const control = await staffList();
    expect(JSON.stringify(await control.json())).toContain(staff.id);
    const { result, fired } = await beforeStatement(
      kit.env,
      RACE_STAFF_STARTS,
      revokeMembership,
      async () => {
        const res = await staffList();
        return { status: res.status, text: await res.text() };
      },
    );
    expect(fired).toBe(true);
    expect(result.status).toBe(200);
    expect(JSON.parse(result.text)).toEqual({ items: [] });
  });
});

describe('the staff roster and the keyset', () => {
  it("fails closed on a keyset that is not this deployment's once a signed scan needs it", async () => {
    const staff = await kit.staff('manager');
    const scanner = await kit.scanner({
      templateIds: [templateId],
      staffId: staff.id,
      settings: { staffSignIn: true },
    });
    await recordedCheckIn(scanner, (await privatePass()).id);
    const control = await staffList();
    expect(control.status).toBe(200);
    expect(JSON.stringify(await control.json())).toContain(staff.id);
    const original = await ensureCredentialRefKeyset(kit.env.DB, kit.env);
    await withoutTrigger(kit.env.DB, 'credential_ref_keyset_no_update', async () => {
      await run(kit.env.DB, 'UPDATE credential_ref_keyset SET commitment = ? WHERE id = 1', [
        'a'.repeat(64),
      ]);
      try {
        const refused = await staffList();
        expect(refused.status).toBe(503);
        expect(await refused.json()).toMatchObject({ code: 'CREDENTIAL_REF_KEYSET_UNAVAILABLE' });
      } finally {
        await run(kit.env.DB, 'UPDATE credential_ref_keyset SET commitment = ? WHERE id = 1', [
          original,
        ]);
      }
    });
  });
});

describe('the API key feed', () => {
  it('is refused when its key is revoked before the page, and a key without the scope is forbidden', async () => {
    const { row } = await recorded();
    const apiKey = fake.apiKey({ orgId: kit.org.id, scopes: ['scans:read'] });
    expect(await (await get('', apiKey)).text()).toContain(row.id);
    const revoked = await beforeBatch(
      kit.env,
      RACE_HISTORY_PAGE,
      (db) =>
        run(db, 'UPDATE api_keys SET revoked_at = ? WHERE org_id = ?', [
          kit.clock.now(),
          kit.org.id,
        ]),
      async () => {
        const res = await get('', apiKey);
        return { status: res.status, text: await res.text() };
      },
    );
    expect(revoked.fired).toBe(true);
    expect(revoked.result.status).toBe(401);
    expect(revoked.result.text).not.toContain(row.id);

    // A key's scopes are immutable in storage, so a scope can only be missing from the start.
    const unscoped = fake.apiKey({ orgId: kit.org.id, scopes: ['passes:read'] });
    const refused = await get('', unscoped);
    expect(refused.status).toBe(403);
    expect(await refused.text()).not.toContain(row.id);
  });

  it("never reads another organization's scans", async () => {
    const { row } = await recorded();
    const other = await makeOrg(kit.fx);
    const foreign = fake.apiKey({ orgId: other.id, scopes: ['scans:read'] });
    const res = await get('', foreign);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ items: [], nextCursor: null });
    const named = await get(`?orgId=${kit.org.id}`, foreign);
    expect(named.status).toBe(403);
    expect(await named.text()).not.toContain(row.id);
    // A platform key naming the org reads it: the positive control for the refusals above.
    const platform = fake.apiKey({ orgId: null, scopes: ['scans:read'] });
    const control = await get(`?orgId=${kit.org.id}`, platform);
    expect(await control.text()).toContain(row.id);
  });
});

describe('the pass or the scanner changed since the scan', () => {
  it.each(['voided', 'quarantined'] as const)(
    'a %s pass is a minimal row in the detail and the list',
    async (change) => {
      const { pass, row } = await recorded();
      const before = await get(`/${row.id}`);
      expect(await before.json()).toMatchObject({ id: row.id, passId: pass.id, passTitle: PUBLIC });
      await run(
        kit.env.DB,
        change === 'voided'
          ? "UPDATE passes SET status = 'voided' WHERE id = ?"
          : 'UPDATE passes SET test_data_quarantined = 1 WHERE id = ?',
        [pass.id],
      );
      const detail = await get(`/${row.id}`);
      // A quarantined pass leaves the ledger scope; a voided one stays as a minimal row.
      if (change === 'quarantined') {
        expect(detail.status).toBe(404);
      } else {
        expect(detail.status).toBe(200);
        const text = await detail.text();
        expect(JSON.parse(text)).toMatchObject({ id: row.id, passId: null, passTitle: null });
        expect(text).not.toContain(PUBLIC);
        expect(text).not.toContain(pass.id);
      }
    },
  );

  it('a renamed scanner hides its name, the id stays', async () => {
    const { scanner, row } = await recorded();
    const name = 'Renamed north gate';
    const before = (await (await get(`/${row.id}`)).json()) as { scannerName: string | null };
    // The control: the recorded name is visible to the viewer before the rename.
    expect(before.scannerName).toEqual(expect.any(String));
    await run(kit.env.DB, 'UPDATE scanners SET name = ? WHERE id = ?', [name, scanner.id]);
    const after = await get(`/${row.id}`);
    expect(await after.json()).toMatchObject({
      id: row.id,
      scannerId: scanner.id,
      scannerName: null,
    });
    const list = (await (await get(`?orgId=${kit.org.id}`)).json()) as {
      items: { scannerName: string | null }[];
    };
    expect(list.items[0]?.scannerName).toBeNull();
  });
});

describe('the export loop and the API-key fence', () => {
  it("judges Wallet validity by each page's own clock, so a pass that expires mid-export stops being exported", async () => {
    const { pass, row } = await recorded();
    const user = await makeUser(kit.fx);
    await grantScanMembership(kit.fx, kit.org.id, user.id);
    const fixture = await makeSession(kit.fx, { userId: user.id, roles: ['admin', 'user'] });
    const session = await createSessionStore(kit.env, kit.clock).resolve(fixture.cookieValue);
    if (!session) throw new Error('The console session must resolve.');
    const authority = await tenantAuthorityOf(kit.ctx, session, kit.org.id, 'scanning:read');
    if (authority.kind !== 'session') throw new Error('Expected session authority');
    const actor = await captureConsoleFeed(kit.ctx, session, authority);
    const start = kit.clock.now();
    await run(
      kit.env.DB,
      "UPDATE pass_versions SET pass_json = json_set(pass_json, '$.expirationDate', ?) WHERE pass_id = ?",
      [new Date(start + 5 * 60_000).toISOString(), pass.id],
    );
    const filter = {
      mode: 'live',
      orgId: kit.org.id,
      from: start - 86_400_000,
      to: start + 86_400_000,
      limit: 1000,
      now: start,
    } as const;
    const page = () =>
      recordPage(kit.ctx, session, authority, filter, {
        actor,
        evidence: createHistoryEvidenceCache(),
        operation: 'export',
      });
    expect((await page()).items[0]).toMatchObject({ id: row.id, passId: pass.id });
    // The export started at `start`; the next page is read after the Wallet pass expired.
    kit.clock.advance(10 * 60_000);
    expect((await page()).items[0]).toMatchObject({ id: row.id, passId: null, passTitle: null });
  });

  it('charges a pass search against the hourly cap before it counts', async () => {
    const { pass } = await recorded();
    const hour = kit.clock.now() - (kit.clock.now() % 3_600_000);
    const key = `scan:export:${adminUserId}`;
    const { fired } = await beforeBatch(
      kit.env,
      RACE_HISTORY_PAGE,
      () => {
        throw new Error('The count never finishes.');
      },
      () => get(exportPath(`&passId=${pass.id}`)),
    );
    expect(fired).toBe(true);
    expect(await read(kit.env.DB, key, hour)).toBe(1);
  });

  it('a platform fence asserts in SQL that its key has no org, and is not a write guard', async () => {
    await recorded();
    const orgKey = fake.apiKey({ orgId: kit.org.id, scopes: ['scans:read'] });
    expect((await get('', orgKey)).status).toBe(200);
    const stored = await first<{ id: string }>(
      kit.env.DB,
      'SELECT id FROM api_keys WHERE org_id = ?',
      [kit.org.id],
    );
    if (!stored) throw new Error('The org key must be stored.');
    // The same key presented as a platform key, naming its own org: refused by the row, not by JS.
    const forged = apiKeyReadAuthority(
      { keyId: stored.id, orgId: null },
      kit.org.id,
      kit.clock.now(),
    );
    const result = await listScanRows(
      kit.env.DB,
      forged,
      { mode: 'live', limit: 10 },
      kit.clock.now(),
    );
    expect(result.rows).toEqual([]);
    // @ts-expect-error A relaxed read fence cannot be an UPDATE guard.
    scanReadFence(forged);
  });
});
