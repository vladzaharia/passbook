import { describe, expect, it } from 'vitest';
import { expectProblem } from '../../../../test/helpers/denial.ts';
import { removeFakeIdp } from '../../../../test/helpers/fake-idp.ts';
import { makeApiKey, makeOrg } from '../../../../test/helpers/index.ts';
import { AccessViewSchema } from '../../../shared/contracts/idp-access.ts';
import { all, first } from '../../platform/db.ts';
import { membership, person, sponsor } from './access-test-fixtures.ts';
import { admin, f, installOpsRig, rig, start } from './ops-test-fixtures.ts';
import { recordObserved } from './repo-state.ts';

installOpsRig();

const base = (id: string) => `/api/v1/users/${id}`;

async function linked() {
  return person(f(), { link: true });
}

describe('access', () => {
  it('is for platform admins; writes need a Polaris ID sign-in', async () => {
    const p = await linked();
    const key = await makeApiKey(f());
    const routes: [string, string, boolean][] = [
      ['GET', `${base(p.id)}/access`, false],
      ['POST', `${base(p.id)}/roles`, true],
      ['POST', `${base(p.id)}/roles/console/remove-external`, true],
      ['POST', `${base(p.id)}/offboard`, true],
    ];
    for (const [method, path, write] of routes) {
      expect((await start(path, method, {})).status).toBe(401);
      expect((await start(path, method, key.headers)).status).toBe(401);
      await expectProblem(
        await start(path, method, (await admin(['user'])).headers),
        403,
        'FORBIDDEN',
      );
      if (write)
        await expectProblem(
          await start(path, method, (await admin(['admin', 'user'], 'magic_link')).headers),
          403,
          'IDP_SIGN_IN_REQUIRED',
        );
    }
  });
});

describe('access view', () => {
  it('lists each role with what wants it and what Polaris ID showed', async () => {
    const p = await linked();
    const org = await makeOrg(f());
    await membership(f(), org.id, p, ['org_admin']);
    await sponsor(f(), org.id, p);
    await recordObserved(rig.h.env.DB, {
      subject: p.subject,
      target: 'developer',
      userId: p.id,
      observed: true,
      presence: 'external',
      now: rig.h.clock.now(),
    });
    rig.idp.addAccount(p.subject, { class: 'linked' });
    const a = await admin();
    const res = await start(`${base(p.id)}/access`, 'GET', a.headers);
    expect(res.status).toBe(200);
    expect(res.headers.get('cache-control')).toBe('no-store');
    const view = AccessViewSchema.parse(await res.json());
    expect(view).toMatchObject({
      connected: true,
      linked: true,
      platformAdmin: false,
      disabled: false,
      account: { class: 'linked', disabledInIdp: false },
    });
    const by = Object.fromEntries(view.roles.map((r) => [r.role, r]));
    expect(by.console).toMatchObject({ wanted: true, memberships: [{ org: { id: org.id } }] });
    expect(by.developer).toMatchObject({
      wanted: true,
      present: true,
      presence: 'external',
      sponsorships: [{ org: { id: org.id } }],
    });
    expect(by.support).toMatchObject({ wanted: false, present: null });
  });

  it('wants nothing for a disabled user or a platform admin, and hides the account when the binding is absent', async () => {
    const org = await makeOrg(f());
    const off = await linked();
    await membership(f(), org.id, off, ['org_admin']);
    await rig.h.env.DB.prepare("UPDATE users SET status = 'disabled' WHERE id = ?")
      .bind(off.id)
      .run();
    const boss = await person(f(), { lastRoles: ['admin', 'user'] });
    await membership(f(), org.id, boss, ['org_admin']);
    const a = await admin();
    const off1 = AccessViewSchema.parse(
      await (await start(`${base(off.id)}/access`, 'GET', a.headers)).json(),
    );
    expect(off1.disabled).toBe(true);
    expect(off1.roles.every((r) => !r.wanted)).toBe(true);
    const boss1 = AccessViewSchema.parse(
      await (await start(`${base(boss.id)}/access`, 'GET', a.headers)).json(),
    );
    expect(boss1.platformAdmin).toBe(true);
    expect(boss1.roles.every((r) => !r.wanted)).toBe(true);
    removeFakeIdp(rig.h.env);
    const gone = AccessViewSchema.parse(
      await (await start(`${base(off.id)}/access`, 'GET', a.headers)).json(),
    );
    expect(gone).toMatchObject({ connected: false, account: { class: null, disabledInIdp: null } });
  });

  it('answers 404 for a user who does not exist', async () => {
    const a = await admin();
    await expectProblem(
      await start(`${base('nobody')}/access`, 'GET', a.headers),
      404,
      'USER_NOT_FOUND',
    );
  });
});

describe('grant and revoke a platform role', () => {
  const roles = (id: string) => `${base(id)}/roles`;

  it('grants once, marks the user for the drain, audits, and revokes', async () => {
    const p = await linked();
    const a = await admin();
    const res = await start(roles(p.id), 'POST', a.headers, { role: 'developer', grant: true });
    expect(res.status).toBe(200);
    const view = AccessViewSchema.parse(await res.json());
    expect(view.roles.find((r) => r.role === 'developer')).toMatchObject({ wanted: true });
    expect(view.roles.find((r) => r.role === 'developer')?.grantedAt).not.toBeNull();
    const mark = await first(rig.h.env.DB, 'SELECT 1 AS m FROM idp_dirty WHERE subject = ?', [
      p.subject,
    ]);
    expect(mark).not.toBeNull();
    await start(roles(p.id), 'POST', a.headers, { role: 'developer', grant: true });
    const rows = await all<{ action: string }>(
      rig.h.env.DB,
      "SELECT action FROM audit_log WHERE target_id = ? AND action LIKE 'idp.role_%'",
      [p.id],
    );
    expect(rows).toEqual([{ action: 'idp.role_grant' }]);
    const off = AccessViewSchema.parse(
      await (
        await start(roles(p.id), 'POST', a.headers, { role: 'developer', grant: false })
      ).json(),
    );
    expect(off.roles.find((r) => r.role === 'developer')).toMatchObject({ wanted: false });
  });

  it('answers a repeated Idempotency-Key from the first call', async () => {
    const p = await linked();
    const a = await admin();
    const headers = { ...a.headers, 'idempotency-key': `role-${p.id}` };
    const body = { role: 'support', grant: true };
    expect((await start(roles(p.id), 'POST', headers, body)).status).toBe(200);
    const again = await start(roles(p.id), 'POST', headers, body);
    expect(again.headers.get('Idempotent-Replayed')).toBe('true');
  });

  it('refuses console, a platform admin and a missing binding', async () => {
    const p = await linked();
    const a = await admin();
    expect(
      (await start(roles(p.id), 'POST', a.headers, { role: 'console', grant: true })).status,
    ).toBe(422);
    const boss = await person(f(), { lastRoles: ['admin', 'user'] });
    await expectProblem(
      await start(roles(boss.id), 'POST', a.headers, { role: 'support', grant: true }),
      409,
      'IDP_PLATFORM_ADMIN',
    );
    const quiet = await linked();
    rig.idp.addAccount(quiet.subject, { class: 'linked', isAdmin: true });
    await expectProblem(
      await start(roles(quiet.id), 'POST', a.headers, { role: 'support', grant: true }),
      409,
      'IDP_PLATFORM_ADMIN',
    );
    removeFakeIdp(rig.h.env);
    await expectProblem(
      await start(roles(p.id), 'POST', a.headers, { role: 'support', grant: true }),
      503,
      'IDP_UNAVAILABLE',
    );
  });
});

describe('remove an external role', () => {
  const url = (id: string, role = 'developer') => `${base(id)}/roles/${role}/remove-external`;

  async function external() {
    const p = await linked();
    rig.idp.addAccount(p.subject, { class: 'linked', roles: ['developer'] });
    await recordObserved(rig.h.env.DB, {
      subject: p.subject,
      target: 'developer',
      userId: p.id,
      observed: true,
      presence: 'external',
      now: rig.h.clock.now(),
    });
    return p;
  }

  it('removes it as an override and records the removal', async () => {
    const p = await external();
    const a = await admin();
    const res = await start(url(p.id), 'POST', a.headers);
    expect(res.status).toBe(200);
    expect(rig.idp.accounts.get(p.subject)?.roles.has('developer')).toBe(false);
    const view = AccessViewSchema.parse(await res.json());
    expect(view.roles.find((r) => r.role === 'developer')).toMatchObject({
      present: false,
      presence: 'none',
    });
    const audit = await all<{ action: string }>(
      rig.h.env.DB,
      "SELECT action FROM audit_log WHERE target_id = ? AND action = 'idp.remove_external'",
      [p.id],
    );
    expect(audit).toHaveLength(1);
  });

  it('refuses a role PassBook did not find there', async () => {
    const p = await linked();
    const a = await admin();
    await expectProblem(await start(url(p.id), 'POST', a.headers), 409, 'IDP_NOT_EXTERNAL');
  });
});
