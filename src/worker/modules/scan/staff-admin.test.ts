import { beforeEach, describe, expect, it } from 'vitest';
import {
  makeOrg,
  makeScanner,
  makeScanStaff,
  makeSession,
  makeUser,
} from '../../../../test/helpers/index.ts';
import { bump } from '../../platform/counters.ts';
import { all, first, run } from '../../platform/db.ts';
import { getStaff } from './repo-staff.ts';
import { setupStaffAdminTestKit } from './staff-admin-test-fixtures.ts';
import { grantScanMembership, ORIGIN } from './test-kit.ts';

const staffAdmin = setupStaffAdminTestKit();
const { admin, binding, codeOf, credential, itemPath, list, query, resetPath, seedAdmin, send } =
  staffAdmin;
let env: typeof staffAdmin.env;
let f: typeof staffAdmin.f;
let clock: typeof staffAdmin.clock;
let fake: typeof staffAdmin.fake;
let orgId: typeof staffAdmin.orgId;
let userId: typeof staffAdmin.userId;
beforeEach(() => {
  ({ env, f, clock, fake, orgId, userId } = staffAdmin);
});

describe('staff administration authorization', () => {
  it('requires a tenant session, not an unauthenticated request, API key or scanner', async () => {
    const person = await makeScanStaff(f, { orgId, pin: '482913' });
    const before = await credential(person.id);
    const requests: [string, string, unknown?][] = [
      ['GET', query()],
      ['POST', '', { orgId, name: 'Unauthorized', role: 'door' }],
      ['PATCH', itemPath(person.id), { role: 'manager' }],
      ['POST', resetPath(person.id)],
    ];
    const principals = [
      { headers: {}, status: 401 },
      { headers: fake.apiKey({ orgId, scopes: ['scans:read'] }), status: 401 },
      { headers: fake.apiKey(), status: 401 },
      { headers: fake.scanner({ orgId }), status: 401 },
      { headers: fake.scanner({ orgId, transport: 'bearer' }), status: 401 },
    ];
    for (const principal of principals) {
      for (const [method, path, body] of requests) {
        const res = await send(method, path, body, principal.headers);
        expect(res.status).toBe(principal.status);
      }
    }
    const outsider = await makeUser(f);
    const session = await makeSession(f, { userId: outsider.id });
    const headers = { ...session.headers, origin: ORIGIN };
    const read = await send('GET', query(), undefined, headers);
    expect(read.status).toBe(200);
    expect(await read.json()).toEqual({ items: [] });
    for (const [method, path, body] of requests.slice(1)) {
      expect((await send(method, path, body, headers)).status).toBe(404);
    }
    expect(await credential(person.id)).toEqual(before);
    expect((await list()).map((staff) => staff.id)).toEqual([person.id]);
    expect(
      await all(env.DB, "SELECT action FROM audit_log WHERE action LIKE 'scan_staff.%'"),
    ).toEqual([]);
    expect((await send('PATCH', itemPath(person.id), { role: 'desk' })).status).toBe(200);
  });

  it('requires same-origin and the session CSRF secret for each mutation, but not reads', async () => {
    const person = await makeScanStaff(f, { orgId, pin: '482913' });
    const headers: Record<string, string> = admin();
    const { 'x-csrf-token': _token, ...noToken } = headers;
    const badHeaders = [
      noToken,
      { ...headers, 'x-csrf-token': 'wrong' },
      { ...headers, origin: 'https://other.example', 'sec-fetch-site': 'cross-site' },
    ];
    const before = await credential(person.id);
    for (const bad of badHeaders) {
      for (const [method, path, body] of [
        ['POST', '', { orgId, name: 'CSRF', role: 'door' }],
        ['PATCH', itemPath(person.id), { disabled: true }],
        ['POST', resetPath(person.id), undefined],
      ] as const) {
        expect((await send(method, path, body, bad)).status).toBe(403);
      }
    }
    expect((await send('GET', query(), undefined, noToken)).status).toBe(200);
    expect(await credential(person.id)).toEqual(before);
    expect(
      await all(env.DB, "SELECT action FROM audit_log WHERE action LIKE 'scan_staff.%'"),
    ).toEqual([]);
    expect((await send('PATCH', itemPath(person.id), { role: 'desk' }, headers)).status).toBe(200);
  });

  it('scopes lists and makes a foreign staff id indistinguishable from a missing one', async () => {
    const other = await makeOrg(f);
    await grantScanMembership(f, other.id, userId);
    const ours = await makeScanStaff(f, { orgId, name: 'Our staff' });
    const theirs = await makeScanStaff(f, { orgId: other.id, name: 'Their staff', pin: '482913' });
    const foreignScanner = await makeScanner(f, { orgId: other.id, staffId: theirs.id });
    const before = await credential(theirs.id);
    const beforeStaff = await getStaff(env.DB, other.id, theirs.id);
    const beforeBinding = await binding(foreignScanner.id);
    expect((await list()).map((staff) => staff.id)).toEqual([ours.id]);
    expect((await list(other.id)).map((staff) => staff.id)).toEqual([theirs.id]);
    for (const id of [theirs.id, 'missing-staff']) {
      const patch = await send('PATCH', itemPath(id), { role: 'manager', disabled: true });
      expect(patch.status).toBe(404);
      expect(await codeOf(patch)).toBe('SCAN_STAFF_NOT_FOUND');
      const reset = await send('POST', resetPath(id));
      expect(reset.status).toBe(404);
      expect(await codeOf(reset)).toBe('SCAN_STAFF_NOT_FOUND');
    }
    expect(await credential(theirs.id)).toEqual(before);
    expect(await getStaff(env.DB, other.id, theirs.id)).toEqual(beforeStaff);
    expect(await binding(foreignScanner.id)).toEqual(beforeBinding);
    expect(
      await all(env.DB, "SELECT action FROM audit_log WHERE action LIKE 'scan_staff.%'"),
    ).toEqual([]);
  });

  it('requires an org parameter and an existing active org for every action', async () => {
    const person = await makeScanStaff(f, { orgId });
    for (const [method, path, body] of [
      ['GET', '', undefined],
      ['POST', '', { name: 'Missing org', role: 'door' }],
      ['PATCH', `/${person.id}`, { name: 'Changed' }],
      ['POST', `/${person.id}/reset-pin`, undefined],
    ] as const) {
      expect((await send(method, path, body)).status).toBe(422);
    }
    const before = await credential(person.id);
    const beforeStaff = await getStaff(env.DB, orgId, person.id);
    for (const org of ['missing-org', orgId, orgId]) {
      if (org === orgId) {
        const current = await first<{ status: string }>(
          env.DB,
          'SELECT status FROM orgs WHERE id = ?',
          [orgId],
        );
        await run(env.DB, 'UPDATE orgs SET status = ? WHERE id = ?', [
          current?.status === 'active' ? 'suspended' : 'deleted',
          orgId,
        ]);
      }
      const read = await send('GET', query(org));
      expect(read.status).toBe(200);
      expect(await read.json()).toEqual({ items: [] });
      const create = await send('POST', '', { orgId: org, name: 'Inactive org', role: 'door' });
      expect(create.status).toBe(404);
      expect(await codeOf(create)).toBe('ORG_NOT_FOUND');
      for (const [method, path, body] of [
        ['PATCH', itemPath(person.id, org), { name: 'Changed' }],
        ['POST', resetPath(person.id, org), undefined],
      ] as const) {
        const res = await send(method, path, body);
        expect(res.status).toBe(404);
        expect(await codeOf(res)).toBe('SCAN_STAFF_NOT_FOUND');
      }
    }
    expect(await credential(person.id)).toEqual(before);
    expect(await getStaff(env.DB, orgId, person.id)).toEqual(beforeStaff);
    expect(
      await all(env.DB, "SELECT action FROM audit_log WHERE action LIKE 'scan_staff.%'"),
    ).toEqual([]);
  });

  it('throttles writes per admin without throttling reads or another admin, then resets the window', async () => {
    const person = await makeScanStaff(f, { orgId });
    const otherAdmin = (await makeUser(f)).id;
    await seedAdmin(otherAdmin);
    const window = clock.now() - (clock.now() % 60_000);
    await bump(env.DB, `scan:staff-admin:write:${userId}`, window, 59);
    expect((await send('PATCH', itemPath(person.id), { role: 'desk' })).status).toBe(200);
    const limited = await send('PATCH', itemPath(person.id), { role: 'manager' });
    expect(limited.status).toBe(429);
    expect(await codeOf(limited)).toBe('RATE_LIMITED');
    expect(limited.headers.get('retry-after')).toBe('60');
    expect((await list())[0]?.role).toBe('desk');
    expect(
      (await send('PATCH', itemPath(person.id), { role: 'door' }, admin(undefined, otherAdmin)))
        .status,
    ).toBe(200);
    clock.advance(60_000);
    expect((await send('PATCH', itemPath(person.id), { role: 'manager' })).status).toBe(200);
  });

  it('limits reads separately per admin and allows them again in the next window', async () => {
    const person = await makeScanStaff(f, { orgId });
    const otherAdmin = (await makeUser(f)).id;
    await seedAdmin(otherAdmin);
    const window = clock.now() - (clock.now() % 60_000);
    await bump(env.DB, `scan:staff-admin:read:${userId}`, window, 239);
    expect((await send('GET', query())).status).toBe(200);
    const limited = await send('GET', query());
    expect(limited.status).toBe(429);
    expect(await codeOf(limited)).toBe('RATE_LIMITED');
    expect(limited.headers.get('retry-after')).toBe('60');
    expect((await send('GET', query(), undefined, admin(undefined, otherAdmin))).status).toBe(200);
    expect((await send('PATCH', itemPath(person.id), { role: 'desk' })).status).toBe(200);
    clock.advance(60_000);
    expect((await send('GET', query())).status).toBe(200);
  });
});
