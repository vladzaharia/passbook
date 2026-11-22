import { beforeAll, describe, expect, it } from 'vitest';
import { expectProblem } from '../../../../test/helpers/denial.ts';
import { all, first, run } from '../../platform/db.ts';
import { credentialKeysFixture, FORMAT } from './credential-keys-test-fixtures.ts';

const t = credentialKeysFixture();
type Keys = Awaited<ReturnType<typeof t.keys>>;
let keys: Keys;
beforeAll(async () => {
  await t.setup();
  keys = await t.keys();
});

let n = 0;
type Made = { staff: { id: string; name: string; role: string }; pin: string | null };
const create = (
  headers: Record<string, string>,
  name = `Ada ${++n}`,
  idem?: string,
  role = 'door',
) => t.send('POST', '/scan-staff', headers, { orgId: t.orgId(), name, role }, idem);
const made = async (headers = keys.admin.headers) => (await (await create(headers)).json()) as Made;
const list = (headers: Record<string, string>, query = '') =>
  t.send('GET', `/scan-staff?orgId=${t.orgId()}${query}`, headers);
const patch = (headers: Record<string, string>, id: string, body: unknown, orgId = t.orgId()) =>
  t.send('PATCH', `/scan-staff/${id}?orgId=${orgId}`, headers, body);
const reset = (headers: Record<string, string>, id: string, idem?: string, orgId = t.orgId()) =>
  t.send('POST', `/scan-staff/${id}/reset-pin?orgId=${orgId}`, headers, undefined, idem);
const staffCount = async () =>
  (await first<{ n: number }>(t.env().DB, 'SELECT count(*) AS n FROM scan_staff'))?.n ?? 0;

/** Signs the person in on a paired scanner: the PIN is good only if the server accepts it. */
async function signsIn(staffId: string, pin: string) {
  const { kit } = t.fixture;
  const scanner = await kit.scanner({
    templateIds: [t.templateId()],
    settings: { staffSignIn: true },
  });
  return (await kit.post(scanner.headers, '/staff', { staffId, pin })).status;
}

describe('staff by scanning:admin key', () => {
  it('creates a person and shows the PIN once', async () => {
    const first1 = await create(keys.admin.headers, 'Once Ada', 'staff-once');
    const replay = await create(keys.admin.headers, 'Once Ada', 'staff-once');
    const people = await (await list(keys.admin.headers)).text();
    const shown = ((await first1.clone().json()) as Made).pin ?? '';
    await t.expectOnce({
      first: first1,
      replay,
      secrets: { pin: FORMAT.pin },
      ids: ['staff.id', 'staff.name'],
      keyId: keys.admin.id,
      action: 'scan_staff.create',
      target: (one) => String((one.staff as { id: string }).id),
      table: 'scan_staff',
      reads: [people],
    });
    const id = ((await first1.json()) as Made).staff.id;
    expect(await signsIn(id, shown)).toBe(200);
    expect(await first(t.env().DB, 'SELECT created_by FROM scan_staff WHERE id = ?', [id])).toEqual(
      { created_by: null },
    );
    await t.expectIdempotencyScope({
      other: (await t.keys()).admin.headers,
      run: (h, variant) => create(h, variant ? 'Another name' : 'Once Ada Two', 'staff-once'),
      secret: 'pin',
      firstSecret: shown,
    });
  });

  it('refuses a duplicate name with 409, writing nothing and costing nothing', async () => {
    const k = await t.key(['scanning:admin']);
    expect((await create(k.headers, 'Twin')).status).toBe(201);
    const [rows, audits] = [await staffCount(), await t.auditCount()];
    for (let i = 0; i < 3; i++)
      await expectProblem(await create(k.headers, 'Twin'), 409, 'STAFF_NAME_TAKEN');
    expect([await staffCount(), await t.auditCount()]).toEqual([rows, audits]);
  });

  it('lists plain accounts with names, and pages', async () => {
    const person = await made();
    const res = await list(keys.admin.headers, '&limit=1');
    expect(res.status).toBe(200);
    const page = (await res.json()) as { items: Record<string, unknown>[]; nextCursor?: string };
    expect(page.items).toHaveLength(1);
    expect(page.nextCursor).toBeDefined();
    const found = await list(keys.admin.headers, `&q=${encodeURIComponent(person.staff.name)}`);
    const items = ((await found.json()) as { items: Record<string, unknown>[] }).items;
    expect(items[0]).toMatchObject({
      id: person.staff.id,
      name: person.staff.name,
      locked: false,
      today: 0,
      lastScan: null,
    });
  });

  it('edits a person: the role change is audited with its fields, a disable unbinds', async () => {
    const person = await made();
    const res = await patch(keys.admin.headers, person.staff.id, { role: 'manager' });
    expect(res.status).toBe(200);
    expect(((await res.json()) as { role: string }).role).toBe('manager');
    const [row] = await t.keyAudit(person.staff.id, 'scan_staff.update');
    expect(row).toMatchObject({ actor_id: keys.admin.id, ip_prefix: '203.0.113.0/24' });
    expect(JSON.parse(row?.detail ?? '{}')).toEqual({ fields: ['role'], role: 'manager' });
    const off = await patch(keys.admin.headers, person.staff.id, { disabled: true });
    expect(((await off.json()) as { disabledAt: number | null }).disabledAt).not.toBeNull();
    expect(await t.keyAudit(person.staff.id, 'scan_staff.disable')).toHaveLength(1);
  });

  it('resets a PIN once: the old one fails, the new one works', async () => {
    const person = await made();
    const first1 = await reset(keys.admin.headers, person.staff.id, 'reset-once');
    const replay = await reset(keys.admin.headers, person.staff.id, 'reset-once');
    const shown = ((await first1.clone().json()) as { pin: string }).pin;
    await t.expectOnce({
      first: first1,
      replay,
      secrets: { pin: FORMAT.pin },
      ids: [],
      keyId: keys.admin.id,
      action: 'scan_staff.pin_reset',
      target: person.staff.id,
      table: 'scan_staff',
      reads: [await (await list(keys.admin.headers)).text()],
    });
    expect(shown).not.toBe(person.pin);
    expect(await signsIn(person.staff.id, shown)).toBe(200);
    expect(await signsIn(person.staff.id, person.pin ?? '')).not.toBe(200);
  });
});

describe('staff: who may call', () => {
  it('refuses scanning:write and scan-setup:read with MISSING_SCOPE, writing nothing', async () => {
    const person = await made();
    const [rows, audits] = [await staffCount(), await t.auditCount()];
    for (const k of [keys.write, keys.read]) {
      await expectProblem(await create(k.headers), 403, 'MISSING_SCOPE');
      await expectProblem(await list(k.headers), 403, 'MISSING_SCOPE');
      await expectProblem(
        await patch(k.headers, person.staff.id, { role: 'desk' }),
        403,
        'MISSING_SCOPE',
      );
      await expectProblem(await reset(k.headers, person.staff.id), 403, 'MISSING_SCOPE');
    }
    expect([await staffCount(), await t.auditCount()]).toEqual([rows, audits]);
  });

  it('gives a platform key 404 and another org an empty page or 404, writing nothing', async () => {
    const person = await made();
    const [rows, audits] = [await staffCount(), await t.auditCount()];
    await expectProblem(await list(keys.platform.headers), 404, 'ORG_NOT_FOUND');
    expect(await (await list(keys.otherOrg.headers)).json()).toEqual({ items: [] });
    for (const k of [keys.platform, keys.otherOrg]) {
      await expectProblem(await create(k.headers), 404, 'ORG_NOT_FOUND');
      await expectProblem(
        await patch(k.headers, person.staff.id, { role: 'desk' }),
        404,
        'SCAN_STAFF_NOT_FOUND',
      );
      await expectProblem(await reset(k.headers, person.staff.id), 404, 'SCAN_STAFF_NOT_FOUND');
    }
    // Naming the person's org from another org's key finds nothing either.
    await expectProblem(
      await patch(keys.otherOrg.headers, person.staff.id, { role: 'desk' }, keys.otherOrgId),
      404,
      'SCAN_STAFF_NOT_FOUND',
    );
    const missing = await reset(keys.admin.headers, '0193a1b2-7c00-7000-8000-00000000ffff');
    const foreign = await reset(keys.otherOrg.headers, person.staff.id);
    expect(missing.status).toBe(404);
    expect(foreign.status).toBe(404);
    expect([await staffCount(), await t.auditCount()]).toEqual([rows, audits]);
  });

  it('refuses a forced test-mode admin key, a restricted key, and stops revoked or expired ones', async () => {
    const person = await made();
    const before = [await staffCount(), await t.auditCount()];
    expect((await create(keys.testAdmin.headers)).status).toBe(403);
    expect((await reset(keys.testAdmin.headers, person.staff.id)).status).toBe(403);
    await expectProblem(await create(keys.restricted.headers), 403, 'API_KEY_RESTRICTED_ROUTE');
    t.fixture.kit.clock.advance(2000);
    for (const k of [keys.revoked, keys.expired])
      await expectProblem(await create(k.headers), 401, 'INVALID_API_KEY');
    expect([await staffCount(), await t.auditCount()]).toEqual(before);
  });

  it('stops at 100 secrets a day, shared with the setup', async () => {
    const k = await t.key(['scanning:admin']);
    const day = Math.floor(t.fixture.kit.clock.now() / 86_400_000) * 86_400_000;
    await run(t.env().DB, 'INSERT INTO counters (key, window_start, count) VALUES (?, ?, 99)', [
      `scan-setup:secrets:${k.id}`,
      day,
    ]);
    expect((await create(k.headers)).status).toBe(201);
    expect((await create(k.headers)).status).toBe(429);
    const person = await made();
    expect((await reset(k.headers, person.staff.id)).status).toBe(429);
  });

  it('keeps the console answers: a session gets its PIN and the full list', async () => {
    const res = await t.fixture.call('POST', '/scan-staff', {
      orgId: t.orgId(),
      name: `Console ${++n}`,
      role: 'desk',
    });
    expect(res.status).toBe(201);
    expect(((await res.json()) as Made).pin).toMatch(FORMAT.pin);
    const people = await t.fixture.call('GET', `/scan-staff?orgId=${t.orgId()}`);
    expect(people.status).toBe(200);
    expect(((await people.json()) as { items: unknown[] }).items.length).toBeGreaterThan(0);
    expect((await all(t.env().DB, 'SELECT id FROM scan_staff LIMIT 1')).length).toBe(1);
  });
});
