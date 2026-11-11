import { beforeEach, describe, expect, it } from 'vitest';
import { makeOrg, makeScanner, makeScanStaff } from '../../../../test/helpers/index.ts';
import { all, first } from '../../platform/db.ts';
import { AppError } from '../../platform/errors.ts';
import { createServiceContext } from '../../platform/service-context.ts';
import { getStaff } from './repo-staff.ts';
import { updateStaff } from './staff-admin.ts';
import { setupStaffAdminTestKit } from './staff-admin-test-fixtures.ts';

const kit = setupStaffAdminTestKit();
let env: typeof kit.env;
let f: typeof kit.f;
let clock: typeof kit.clock;
let orgId: typeof kit.orgId;
beforeEach(() => {
  ({ env, f, clock, orgId } = kit);
});

const boundTo = (staffId: string) =>
  all<{ id: string }>(env.DB, 'SELECT id FROM scanners WHERE staff_id = ?', [staffId]);

describe('staff writes are grants', () => {
  it('a PIN reset signs the person out of every device in the same batch', async () => {
    const person = await makeScanStaff(f, { orgId, role: 'door', pin: '482913' });
    const live = await makeScanner(f, {
      orgId,
      staffId: person.id,
      settings: { staffSignIn: true },
    });
    const test = await makeScanner(f, {
      orgId,
      mode: 'test',
      staffId: person.id,
      settings: { staffSignIn: true },
    });
    expect((await boundTo(person.id)).map((r) => r.id).sort()).toEqual([live.id, test.id].sort());
    const before = await getStaff(env.DB, orgId, person.id);
    const res = await kit.send('POST', kit.resetPath(person.id));
    expect(res.status).toBe(200);
    expect(await boundTo(person.id)).toEqual([]);
    const after = await getStaff(env.DB, orgId, person.id);
    expect(after?.pinHash).not.toBe(before?.pinHash);
    // The epoch moved with the credential: a PIN checked against the old row is stale.
    expect(after?.authEpoch).toBeGreaterThan(before?.authEpoch ?? 0);
    const audited = await all<{ action: string }>(
      env.DB,
      "SELECT action FROM audit_log WHERE action = 'scan_staff.pin_reset'",
    );
    expect(audited).toHaveLength(1);
  });

  it('create, edit, disable and reset do not depend on the credential keyset or on activity', async () => {
    const key = env.KEK_V1;
    // A different key ring makes the stored keyset unusable for every read that pins it.
    Object.assign(env, { KEK_V1: btoa('z'.repeat(32)) });
    try {
      const created = await kit.send('POST', '', { orgId, name: 'Ada', role: 'door' });
      expect(created.status).toBe(201);
      const { staff } = (await created.json()) as { staff: { id: string; lastScan: unknown } };
      expect(staff.lastScan).toBeNull();
      const edited = await kit.send('PATCH', kit.itemPath(staff.id), { role: 'desk' });
      expect(edited.status).toBe(200);
      expect((await edited.json()) as { role: string }).toMatchObject({ role: 'desk' });
      expect((await kit.send('POST', kit.resetPath(staff.id))).status).toBe(200);
      const disabled = await kit.send('PATCH', kit.itemPath(staff.id), { disabled: true });
      expect(disabled.status).toBe(200);
      expect(
        await first<{ disabled_at: number }>(
          env.DB,
          'SELECT disabled_at FROM scan_staff WHERE id = ?',
          [staff.id],
        ),
      ).not.toBeNull();
    } finally {
      Object.assign(env, { KEK_V1: key });
    }
  });

  it('refuses another organization’s staff member and changes nothing', async () => {
    const other = await makeOrg(f);
    const foreign = await makeScanStaff(f, { orgId: other.id, name: 'Foreign', role: 'door' });
    const ctx = createServiceContext(env, { clock });
    const { auth, authority } = await kit.serviceAuthority(ctx);
    const row = await getStaff(env.DB, other.id, foreign.id);
    if (!row) throw new Error('Missing staff fixture.');
    const error = await updateStaff(ctx, auth, authority, row, authority.mode, {
      name: 'Hijacked',
      role: 'manager',
    }).then(
      () => null,
      (e: unknown) => e,
    );
    expect(error).toBeInstanceOf(AppError);
    // A refusal, never a write: the grant finds no such staff member in this organization.
    expect((error as AppError).status).toBeGreaterThanOrEqual(400);
    expect((error as AppError).status).toBeLessThan(500);
    expect(
      await first<{ name: string; role: string }>(
        env.DB,
        'SELECT name, role FROM scan_staff WHERE id = ?',
        [foreign.id],
      ),
    ).toEqual({ name: 'Foreign', role: 'door' });
  });

  it('lists a bounded, searchable page', async () => {
    for (const name of ['Aaron', 'Abby', 'Bela', 'Cleo']) await kit.create(name);
    const page = await kit.send('GET', `${kit.query()}&limit=2`);
    expect(page.status).toBe(200);
    const body = (await page.json()) as { items: { name: string }[]; hasMore?: boolean };
    expect(body.items.map((s) => s.name)).toEqual(['Aaron', 'Abby']);
    expect(body.hasMore).toBe(true);
    const found = await kit.send('GET', `${kit.query()}&q=bel`);
    const names = ((await found.json()) as { items: { name: string }[] }).items.map((s) => s.name);
    expect(names).toEqual(['Bela']);
  });

  it('pages by cursor to the end, past the page maximum, in list order', async () => {
    const names = Array.from({ length: 7 }, (_, i) => `Person ${i}`);
    for (const name of names) await kit.create(name);
    const seen: string[] = [];
    let cursor: string | undefined;
    for (let pages = 0; pages < 10; pages++) {
      const res = await kit.send(
        'GET',
        `${kit.query()}&limit=3${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`,
      );
      expect(res.status).toBe(200);
      const body = (await res.json()) as {
        items: { name: string }[];
        hasMore?: boolean;
        nextCursor?: string;
      };
      seen.push(...body.items.map((s) => s.name));
      cursor = body.nextCursor;
      if (!cursor) {
        expect(body.hasMore).toBeUndefined();
        break;
      }
    }
    expect(seen).toEqual(names);
    const bad = await kit.send('GET', `${kit.query()}&cursor=garbage`);
    expect(bad.status).toBe(422);
  });
});
