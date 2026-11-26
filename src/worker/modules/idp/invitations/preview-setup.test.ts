import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { expectProblem } from '../../../../../test/helpers/denial.ts';
import {
  createFakeIdp,
  installFakeIdp,
  removeFakeIdp,
} from '../../../../../test/helpers/fake-idp.ts';
import { makeUser } from '../../../../../test/helpers/index.ts';
import { run } from '../../../platform/db.ts';
import { f } from '../../api-keys/test-kit.ts';
import {
  challenge,
  DAY,
  developerInvite,
  memberInvite,
  oneOf,
  post,
  type Rig,
  rig,
  rowsOf,
  teardown,
} from './invitations-test-fixtures.ts';

let r: Rig;
beforeEach(async () => {
  r = await rig();
});
afterEach(teardown);

describe('POST /invitations/preview', () => {
  it('names a member invitation from its prefixed or its older unprefixed secret, with the address hidden', async () => {
    const prefixed = await memberInvite(r, 'agent@agency.test', { roles: ['pass_operator'] });
    const legacy = await memberInvite(r, 'old@agency.test', { prefix: false });
    for (const [invite, email] of [
      [prefixed, 'a•••@agency.test'],
      [legacy, 'o•••@agency.test'],
    ] as const) {
      const res = await post(r, '/preview', { token: invite.secret });
      expect(res.status).toBe(200);
      expect(res.headers.get('cache-control')).toBe('no-store');
      expect(await res.json()).toMatchObject({
        kind: 'member',
        developer: false,
        email,
        polaris: true,
      });
    }
    expect(await (await post(r, '/preview', { token: prefixed.secret })).json()).toMatchObject({
      roles: ['pass_operator'],
    });
  });

  it('reads a developer invitation, with its paired roles, from its own table', async () => {
    const paired = await developerInvite(r, 'dev@agency.test', { roles: ['read_only'] });
    const alone = await developerInvite(r, 'solo@agency.test');
    expect(await (await post(r, '/preview', { token: paired.secret })).json()).toMatchObject({
      kind: 'developer',
      developer: true,
      roles: ['read_only'],
      polaris: true,
    });
    expect(await (await post(r, '/preview', { token: alone.secret })).json()).toMatchObject({
      kind: 'developer',
      roles: [],
    });
  });

  it('answers the same for an unknown secret, a platform one, a malformed one and an ended one', async () => {
    const revoked = await memberInvite(r, 'gone@agency.test');
    await run(r.h.env.DB, 'UPDATE org_invitations SET revoked_at = ? WHERE id = ?', [
      r.h.clock.now(),
      revoked.id,
    ]);
    const expired = await memberInvite(r, 'late@agency.test', { expiresIn: 1000 });
    r.h.clock.advance(2000);
    const other = await memberInvite(r, 'x@agency.test');
    for (const token of [
      revoked.secret,
      expired.secret,
      `p_${'a'.repeat(43)}`,
      `m_${'a'.repeat(43)}`,
      // A member secret's body without its prefix is another string: it is hashed whole, so it is not found.
      other.secret.slice(2),
    ])
      await expectProblem(await post(r, '/preview', { token }), 400, 'INVITATION_INVALID');
    expect((await post(r, '/preview', { token: 'short' })).status).toBe(422);
  });

  it('says polaris false while Polaris ID is in dry run, frozen or absent, and for a paired role without a console group', async () => {
    const invite = await memberInvite(r, 'agent@agency.test');
    for (const fake of [createFakeIdp({ mode: 'dry_run' }), createFakeIdp()]) {
      if (fake.mode === 'live')
        await fake.freeze('test', { ref: 't', reason: 't', actor: { kind: 'system', job: 't' } });
      installFakeIdp(r.h.env, fake);
      expect(await (await post(r, '/preview', { token: invite.secret })).json()).toMatchObject({
        polaris: false,
      });
    }
    removeFakeIdp(r.h.env);
    expect(await (await post(r, '/preview', { token: invite.secret })).json()).toMatchObject({
      polaris: false,
    });
  });
});

describe('POST /invitations/setup', () => {
  it('mints a one-hour token with the console group at the click, and keeps only its id', async () => {
    const invite = await memberInvite(r, 'agent@agency.test');
    const res = await post(r, '/setup', challenge(invite.secret));
    expect(res.status).toBe(200);
    expect(res.headers.get('cache-control')).toBe('no-store');
    const body = (await res.json()) as { setupUrl: string; expiresAt: number };
    expect(body.setupUrl).toMatch(/^https:\/\/id\.test\/st\//);
    expect(body.expiresAt).toBe(r.h.clock.now() + 3_600_000);
    const [signup] = [...r.idp.signups.values()];
    expect(signup).toMatchObject({ kind: 'member', targets: ['console'], ref: invite.id });
    const [row] = await rowsOf(r, 'SELECT * FROM org_invitation_setups WHERE invitation_id = ?', [
      invite.id,
    ]);
    expect(row).toMatchObject({ idp_token_id: signup?.tokenId, expires_at: body.expiresAt });
    expect(JSON.stringify(row)).not.toContain('/st/');
    const audit = await oneOf(
      r,
      "SELECT actor_type, detail FROM audit_log WHERE action = 'org_invitation.setup' AND org_id = ?",
      [r.orgId],
    );
    expect(audit).toMatchObject({ actor_type: 'system', detail: '{"n":1}' });
  });

  it('carries developer, and console with the custom groups the invited roles meet', async () => {
    await r.idp.createGroup('crew', 'Crew', {
      ref: 't',
      reason: 't',
      actor: { kind: 'system', job: 't' },
    });
    const admin = await makeUser(f());
    await run(
      r.h.env.DB,
      "INSERT INTO idp_groups (key, kind, friendly_name, created_at) VALUES ('crew', 'custom', 'Crew', ?)",
      [r.h.clock.now()],
    );
    await run(
      r.h.env.DB,
      'INSERT INTO idp_group_rules (id, group_key, org_id, org_roles, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?)',
      [f().ids.id(), 'crew', r.orgId, '["read_only"]', admin.id, r.h.clock.now()],
    );
    const paired = await developerInvite(r, 'dev@agency.test', { roles: ['read_only'] });
    const other = await developerInvite(r, 'ops@agency.test', { roles: ['pass_operator'] });
    const alone = await developerInvite(r, 'solo@agency.test');
    for (const invite of [paired, other, alone])
      expect((await post(r, '/setup', challenge(invite.secret))).status).toBe(200);
    const kinds = [...r.idp.signups.values()].map((s) => [s.kind, s.targets]);
    expect(kinds).toEqual([
      ['member_developer', ['developer', 'console', 'g:crew']],
      ['member_developer', ['developer', 'console']],
      ['developer', ['developer']],
    ]);
    const claim = await oneOf(r, 'SELECT claim_until FROM developer_invitations WHERE id = ?', [
      paired.id,
    ]);
    expect(claim?.claim_until).toBe(r.h.clock.now() + 7 * DAY);
  });

  it('refuses a bad Turnstile answer, an ended invitation and Polaris ID being away, and mints nothing', async () => {
    const invite = await memberInvite(r, 'agent@agency.test');
    r.h.turnstileOk.value = false;
    await expectProblem(await post(r, '/setup', challenge(invite.secret)), 403, 'TURNSTILE_FAILED');
    r.h.turnstileOk.value = true;
    installFakeIdp(r.h.env, createFakeIdp({ mode: 'dry_run' }));
    await expectProblem(await post(r, '/setup', challenge(invite.secret)), 503, 'IDP_UNAVAILABLE');
    installFakeIdp(r.h.env, r.idp);
    await expectProblem(
      await post(r, '/setup', challenge(`m_${'b'.repeat(43)}`)),
      400,
      'INVITATION_INVALID',
    );
    await run(r.h.env.DB, 'UPDATE org_invitations SET revoked_at = ? WHERE id = ?', [
      r.h.clock.now(),
      invite.id,
    ]);
    await expectProblem(
      await post(r, '/setup', challenge(invite.secret)),
      400,
      'INVITATION_INVALID',
    );
    expect(r.idp.signups.size).toBe(0);
    expect(
      await rowsOf(r, 'SELECT 1 FROM org_invitation_setups WHERE invitation_id = ?', [invite.id]),
    ).toHaveLength(0);
  });

  it('caps links at three, and a new link withdraws the previous unused one', async () => {
    const invite = await memberInvite(r, 'agent@agency.test');
    const made: string[] = [];
    for (let i = 0; i < 3; i++) {
      expect((await post(r, '/setup', challenge(invite.secret))).status).toBe(200);
      made.push(...[...r.idp.signups.keys()].filter((id) => !made.includes(id)));
    }
    expect(made).toHaveLength(3);
    expect(made.map((id) => r.idp.signups.has(id))).toEqual([false, false, true]);
    await expectProblem(
      await post(r, '/setup', challenge(invite.secret)),
      429,
      'INVITATION_SETUP_CAPPED',
    );
    expect(r.idp.signups.size).toBe(1);
  });

  it('keeps a token someone already used when the next link is made', async () => {
    const invite = await memberInvite(r, 'agent@agency.test');
    await post(r, '/setup', challenge(invite.secret));
    const [used] = [...r.idp.signups.keys()];
    r.idp.completeSignup(used as string, 'sub-made');
    await post(r, '/setup', challenge(invite.secret));
    expect(r.idp.signups.has(used as string)).toBe(true);
  });

  it('does not offer a new link to a developer invitation past its first window, but lets it be finished', async () => {
    const invite = await developerInvite(r, 'dev@agency.test');
    r.h.clock.advance(6.5 * DAY);
    expect((await post(r, '/setup', challenge(invite.secret))).status).toBe(200);
    r.h.clock.advance(DAY / 2 + 60_000);
    // The setup moved the window to a day after it: the invitation can still be finished, not restarted.
    await expectProblem(
      await post(r, '/setup', challenge(invite.secret)),
      400,
      'INVITATION_INVALID',
    );
    const preview = await post(r, '/preview', { token: invite.secret });
    expect(preview.status).toBe(200);
    expect(await preview.json()).toMatchObject({ polaris: false });
  });
});
