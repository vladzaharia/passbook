import { describe, expect, it } from 'vitest';
import { makeSession, makeUser } from '../../../../test/helpers/index.ts';
import { first, run } from '../../platform/db.ts';
import { createSessionStore, hashSessionCookie } from '../auth/sessions.ts';
import { approveAppleRelease } from '../passes/apple-release-test-fixtures.ts';
import { requireCredentialRefKeyset } from '../passes/credential-keyset.ts';
import { tenantAuthorityOf } from '../passes/http.ts';
import { ICON_PNG } from '../passes/pass-test-fixtures.ts';
import { buildKey as templateBuildKey } from '../templates/package/hash.ts';
import { scanSessionCsrfProof } from './actor.ts';
import { recordedCheckIn } from './console-privacy-actions-test-fixtures.ts';
import {
  adminSessionId,
  expectNoSecrets,
  exportPath,
  get,
  HIDDEN,
  insertVersion,
  kit,
  MANAGER,
  PUBLIC,
  page,
  privatePass,
  seedScan,
  setupPrivacyKit,
  templateId,
} from './console-privacy-test-fixtures.ts';
import { recordsOf } from './feed-projection.ts';
import { createFeedProofCache, verifyRows } from './feed-proof.ts';
import { getScanRow } from './repo-feed.ts';
import { grantScanMembership, ORIGIN } from './test-kit.ts';

setupPrivacyKit();

describe('scan console and feed privacy', () => {
  it('uses tenant roles for manager-only values in list, detail, search and CSV', async () => {
    const base = await kit.registry.resolve(templateId);
    const restricted = kit.registry.add({
      id: kit.fx.ids.id(),
      orgId: kit.org.id,
      manifest: {
        ...base.manifest,
        name: 'Role-projected card',
        display: { ...base.manifest.display, title: '{{tier}}' },
        scan: {
          actions: [
            {
              id: 'manager_set',
              label: 'Manager value',
              kind: 'set',
              input: 'tier',
              minRole: 'manager',
            },
            {
              id: 'manager_entry',
              label: 'Exclusive balcony entry',
              kind: 'check_in',
              minRole: 'manager',
            },
          ],
        },
      },
      passJson: base.passJson,
      assets: { 'icon.png': ICON_PNG },
    });
    await run(
      kit.env.DB,
      `INSERT INTO templates (id, org_id, slug, name, origin, active_version, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        restricted.id,
        kit.org.id,
        restricted.id,
        restricted.manifest.name,
        restricted.origin,
        restricted.version,
        kit.clock.now(),
        kit.clock.now(),
      ],
    );
    await insertVersion(restricted, await templateBuildKey(restricted));
    await approveAppleRelease(kit, {
      orgId: kit.org.id,
      mode: 'live',
      templateId: restricted.id,
      version: restricted.version,
    });
    const staff = await kit.staff('manager');
    const scanner = await kit.scanner({
      templateIds: [restricted.id],
      staffId: staff.id,
      settings: { staffSignIn: true },
    });
    const pass = await kit.scanPass(restricted.id, {
      memberName: PUBLIC,
      tier: MANAGER,
      privateNotes: HIDDEN,
    });
    const row = await seedScan({
      scanner,
      passId: pass.id,
      templateId: restricted.id,
      actionId: 'manager_set',
      actionKind: 'set',
      passVersion: pass.version,
      before: MANAGER,
      after: MANAGER,
    });
    const checkIn = await recordedCheckIn(scanner, pass.id, 'manager_entry');

    const listPath = `?orgId=${kit.org.id}`;
    const search = `${listPath}&q=${encodeURIComponent(MANAGER)}`;
    const managerList = await page(listPath);
    expect(managerList.items.find((item) => item.id === row.id)).toMatchObject({
      id: row.id,
      passId: null,
      passTitle: null,
      before: null,
      after: null,
    });
    expect(managerList.items.find((item) => item.id === checkIn.id)).toMatchObject({
      passId: pass.id,
      passTitle: MANAGER,
      actionId: 'manager_entry',
      actionLabel: 'Exclusive balcony entry',
    });
    expect((await page(search)).items.map((item) => item.id)).toEqual([checkIn.id]);
    const managerDetail = await get(`/${row.id}`);
    expect(managerDetail.status).toBe(200);
    expect(await managerDetail.json()).toMatchObject({
      passId: null,
      passTitle: null,
      before: null,
      after: null,
    });
    const managerEntryDetail = await get(`/${checkIn.id}`);
    expect(managerEntryDetail.status).toBe(200);
    expect(await managerEntryDetail.json()).toMatchObject({
      actionId: 'manager_entry',
      actionLabel: 'Exclusive balcony entry',
    });
    const managerCsv = await get(exportPath());
    expect(managerCsv.status).toBe(200);
    const managerCsvText = await managerCsv.text();
    expect(managerCsvText).toContain(MANAGER);
    expect(managerCsvText).toContain('Exclusive balcony entry');

    for (const role of ['read_only', 'pass_operator'] as const) {
      const user = await makeUser(kit.fx);
      await grantScanMembership(kit.fx, kit.org.id, user.id, [role]);
      // Even a global administrator is restricted to this membership's scanner role.
      const headers = {
        ...(await makeSession(kit.fx, { userId: user.id, roles: ['admin', 'user'] })).headers,
        origin: ORIGIN,
      };
      const list = await page(listPath, headers);
      expect(list.items).toHaveLength(2);
      expect(list.items.find((item) => item.id === row.id)).toMatchObject({
        id: row.id,
        passTitle: null,
        before: null,
        after: null,
      });
      expect(list.items.find((item) => item.id === checkIn.id)).toMatchObject({
        kind: null,
        direction: null,
        actionId: null,
        actionLabel: null,
      });
      expect(JSON.stringify(list)).not.toContain(MANAGER);
      expect((await page(search, headers)).items).toEqual([]);
      const detail = await get(`/${row.id}`, headers);
      expect(detail.status).toBe(200);
      expect(await detail.text()).not.toContain(MANAGER);
      const entryDetail = await get(`/${checkIn.id}`, headers);
      expect(entryDetail.status).toBe(200);
      expect(await entryDetail.json()).toMatchObject({
        kind: null,
        direction: null,
        actionId: null,
        actionLabel: null,
      });
      const csv = await get(exportPath(), headers);
      expect(csv.status).toBe(200);
      const csvText = await csv.text();
      expect(csvText).not.toContain(MANAGER);
      expect(csvText).not.toContain('Exclusive balcony entry');
      expect(csvText).not.toContain('Check in');
      const searchedCsv = await get(exportPath(`&q=${encodeURIComponent(MANAGER)}`), headers);
      expect(searchedCsv.status).toBe(200);
      expect(
        (await searchedCsv.text())
          .replace(/^\uFEFF/, '')
          .trimEnd()
          .split('\r\n'),
      ).toHaveLength(1);
    }
  });

  it('captures an ID-bound CSRF proof in console projection authority', async () => {
    const scanner = await kit.scanner({ templateIds: [templateId] });
    const pass = await privatePass();
    const scan = await recordedCheckIn(scanner, pass.id);
    const user = await makeUser(kit.fx);
    await grantScanMembership(kit.fx, kit.org.id, user.id);
    const session = await makeSession(kit.fx, { userId: user.id });
    const other = await makeSession(kit.fx, { userId: user.id });
    const auth = await createSessionStore(kit.env, kit.clock).resolve(session.cookieValue);
    if (!auth) throw new Error('The console session must resolve.');
    const authority = await tenantAuthorityOf(kit.ctx, auth, kit.org.id, 'scanning:read');
    if (authority.kind !== 'session')
      throw new Error('The console authority must be session-backed.');
    const row = await getScanRow(kit.env.DB, scan.id, kit.clock.now(), 'live');
    if (!row) throw new Error('The recorded scan must be available.');
    const keyset = await requireCredentialRefKeyset(kit.env.DB, kit.env);
    // Rows reach the projection only after their recorded facts are checked, as in the feed.
    const verified = await verifyRows(kit.ctx, [row], createFeedProofCache(keyset));
    const [projection] = await recordsOf(kit.ctx, auth, authority, keyset, verified.rows);
    if (!projection?.snapshot.actor.tenantAuthority)
      throw new Error('The projection must capture its tenant actor.');
    expect(projection.record).toMatchObject({ id: scan.id, passId: pass.id, passTitle: PUBLIC });
    const proof = projection.snapshot.actor.tenantAuthority.sessionCsrfProof;
    expect(proof).toBe(await scanSessionCsrfProof(kit.env, auth.sessionId, auth.csrfSecret));
    const otherSessionId = await hashSessionCookie(other.cookieValue);
    expect(otherSessionId).not.toBe(auth.sessionId);
    expect(proof).not.toBe(await scanSessionCsrfProof(kit.env, otherSessionId, auth.csrfSecret));
    expect(JSON.stringify(projection.snapshot.actor)).not.toContain(auth.csrfSecret);
  });

  it.each([
    ['list', 'csrf rotation'],
    ['detail', 'csrf rotation'],
    ['list', 'revocation'],
    ['detail', 'revocation'],
  ] as const)(
    'keeps console %s authority current after session %s races selection',
    async (surface, change) => {
      const scanner = await kit.scanner({ templateIds: [templateId] });
      const pass = await privatePass();
      const scan = await recordedCheckIn(scanner, pass.id);
      const path = surface === 'list' ? `?orgId=${kit.org.id}` : `/${scan.id}`;
      const baseline = await get(path);
      expect(baseline.status).toBe(200);
      const expected = { id: scan.id, passId: pass.id, passTitle: PUBLIC, actionId: 'check_in' };
      expect(await baseline.json()).toMatchObject(
        surface === 'list' ? { items: [expected] } : expected,
      );
      const db = kit.env.DB;
      const original = await first<{ csrf_secret: string }>(
        db,
        'SELECT csrf_secret FROM sessions WHERE id_hash = ?',
        [adminSessionId],
      );
      if (!original) throw new Error('The original console session must exist.');
      let intercepted = 0;
      const wrap = (statement: D1PreparedStatement): D1PreparedStatement =>
        new Proxy(statement, {
          get(target, property) {
            if (property === 'bind') return (...values: unknown[]) => wrap(target.bind(...values));
            if (property === (surface === 'list' ? 'all' : 'first'))
              return async () => {
                const result = surface === 'list' ? await target.all() : await target.first();
                if (intercepted === 0) {
                  intercepted++;
                  if (change === 'csrf rotation') {
                    await expect(
                      run(db, 'UPDATE sessions SET csrf_secret = ? WHERE id_hash = ?', [
                        'replacement-csrf-secret',
                        adminSessionId,
                      ]),
                    ).rejects.toThrow('session csrf secret is immutable');
                  } else {
                    expect(
                      await run(db, 'UPDATE sessions SET revoked_at = ? WHERE id_hash = ?', [
                        kit.clock.now(),
                        adminSessionId,
                      ]),
                    ).toEqual({ changes: 1 });
                  }
                }
                return result;
              };
            const value = Reflect.get(target, property, target);
            return typeof value === 'function' ? value.bind(target) : value;
          },
        });
      const proxy = new Proxy(db, {
        get(target, property) {
          if (property === 'prepare')
            return (sql: string) => {
              const statement = target.prepare(sql);
              const select =
                surface === 'list'
                  ? /FROM\s+scans\s+s[\s\S]*ORDER BY s\.at DESC/i
                  : /FROM\s+scans\s+s[\s\S]*WHERE\s+s\.id\s*=\s*\?/i;
              return select.test(sql) ? wrap(statement) : statement;
            };
          const value = Reflect.get(target, property, target);
          return typeof value === 'function' ? value.bind(target) : value;
        },
      });
      Object.assign(kit.env, { DB: proxy });
      try {
        const response = await get(path);
        const body = await response.text();
        expect(intercepted).toBe(1);
        expect(
          await first(db, 'SELECT csrf_secret FROM sessions WHERE id_hash = ?', [adminSessionId]),
        ).toEqual(original);
        if (change === 'csrf rotation') {
          expect(response.status).toBe(200);
          expect(JSON.parse(body)).toMatchObject(
            surface === 'list' ? { items: [expected] } : expected,
          );
        } else {
          expect(response.status).toBe(surface === 'list' ? 403 : 404);
          expect(body).not.toContain(scan.id);
          expect(body).not.toContain(pass.id);
          expect(body).not.toContain(PUBLIC);
          expectNoSecrets(body, pass);
        }
      } finally {
        Object.assign(kit.env, { DB: db });
      }
    },
  );
});
