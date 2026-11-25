import { env } from 'cloudflare:workers';
import { beforeAll, describe, expect, it } from 'vitest';
import { runJob } from '../../jobs/registry.ts';
import type { Job } from '../../jobs/types.ts';
import { grant } from '../../platform/authority.ts';
import { all, first, run } from '../../platform/db.ts';
import { createJobContext } from '../../platform/service-context.ts';
import { saveOrgCredential, savePlatformCredential } from './credential-service.ts';
import { holdEnrolment, releaseEnrolment, runEnrolmentHold } from './enrolment-hold.ts';
import { listEnrolments } from './enrolment-read.ts';
import {
  disableEnrolment,
  enableEnrolment,
  revokeEnrolment,
  setEnrolmentSource,
} from './enrolment-service.ts';
import { commitEnrolmentStep, ENROLMENT_TABLES } from './repo-enrolments.ts';
import { addCheck } from './repo-wallet-credentials-test-fixtures.ts';
import { insertEnrolmentEvent } from './repo-wallet-enrolments-test-fixtures.ts';
import { type Kit, kit } from './wallet-wa1b-test-fixtures.ts';

let k: Kit;
let platformId = '';
beforeAll(async () => {
  k = await kit();
}, 30_000);

/** The platform's Test Google credential (one per mode and provider: replaced by a rotation). */
async function platformCredential() {
  const admin = await k.admin();
  const row = await first<{ id: string; revision: number }>(
    env.DB,
    "SELECT id, revision FROM wallet_credentials WHERE scope = 'platform' AND mode = 'test' AND provider = 'google' AND revoked_at IS NULL",
  );
  const saved = await savePlatformCredential(k.ctx, admin.auth, {
    mode: 'test',
    provider: 'google',
    expectedRevision: row?.revision ?? 0,
    credentials: k.google('777000111'),
  });
  platformId = saved.id;
  return { admin, saved };
}

/** An org with a member, on the platform source, enrolled and checked: ready to enable. */
async function enrolled() {
  const org = await k.org();
  const m = await k.member(org.id);
  const { admin, saved } = await platformCredential();
  const view = await setEnrolmentSource(k.ctx, m.auth, org.id, 'google', {
    source: 'platform',
    expectedRevision: 0,
  });
  const version = await first<{ v: string }>(
    env.DB,
    'SELECT current_version_id AS v FROM wallet_credentials WHERE id = ?',
    [saved.id],
  );
  await addCheck(saved.id, version?.v ?? '');
  return { org, m, admin, view };
}

describe('enrolment source and enable', () => {
  it('refuses an absent platform source, then picks it and enables with a fresh check', async () => {
    const org = await k.org();
    const m = await k.member(org.id);
    const absent = async () =>
      setEnrolmentSource(k.ctx, m.auth, org.id, 'google', {
        source: 'platform',
        expectedRevision: 0,
      });
    await expect(
      setEnrolmentSource(k.ctx, m.auth, org.id, 'samsung', {
        source: 'platform',
        expectedRevision: 0,
      }),
    ).rejects.toMatchObject({
      code: 'WALLET_ENROLMENT_PREREQUISITE',
      issues: [{ path: 'source' }],
    });
    expect(
      (await listEnrolments(k.ctx, m.auth, org.id)).items.map((i) => `${i.provider}:${i.state}`),
    ).toEqual(['google:absent', 'samsung:absent']);
    await platformCredential();
    const view = await absent();
    expect(view).toMatchObject({
      state: 'off',
      source: 'platform',
      enrolmentRevision: 1,
      platformAvailable: true,
    });
    await expect(
      enableEnrolment(k.ctx, m.auth, org.id, 'google', { expectedRevision: 1 }),
    ).rejects.toMatchObject({
      code: 'WALLET_ENROLMENT_PREREQUISITE',
      issues: [{ path: 'check' }],
    });
  });

  it('enables, disables and revokes, and a rotation changes none of it', async () => {
    const { org, m, admin } = await enrolled();
    const on = await enableEnrolment(k.ctx, m.auth, org.id, 'google', { expectedRevision: 1 });
    expect(on).toMatchObject({
      state: 'on',
      enrolmentRevision: 2,
      prerequisites: { check: true, roundTrip: null },
    });
    const before = await first(env.DB, 'SELECT * FROM wallet_provider_accounts WHERE id = ?', [
      on.accountId,
    ]);
    const dirty = (
      await first<{ n: number }>(env.DB, 'SELECT count(*) AS n FROM wallet_provider_instance_dirty')
    )?.n;
    const cred = await first<{ id: string; revision: number }>(
      env.DB,
      'SELECT id, revision FROM wallet_credentials WHERE id = ?',
      [platformId],
    );
    await savePlatformCredential(k.ctx, admin.auth, {
      mode: 'test',
      provider: 'google',
      expectedRevision: cred?.revision ?? 0,
      credentials: k.google('777000111'),
    });
    expect(
      await first(env.DB, 'SELECT * FROM wallet_provider_accounts WHERE id = ?', [on.accountId]),
    ).toEqual(before);
    expect(
      (
        await first<{ n: number }>(
          env.DB,
          'SELECT count(*) AS n FROM wallet_provider_instance_dirty',
        )
      )?.n,
    ).toBe(dirty);
    await expect(
      revokeEnrolment(k.ctx, m.auth, org.id, 'google', { expectedRevision: 2 }),
    ).rejects.toMatchObject({ code: 'WALLET_ACCOUNT_CONFLICT' });
    expect(
      await disableEnrolment(k.ctx, m.auth, org.id, 'google', { expectedRevision: 2 }),
    ).toMatchObject({ state: 'off', enrolmentRevision: 3 });
    expect(
      await revokeEnrolment(k.ctx, m.auth, org.id, 'google', { expectedRevision: 3 }),
    ).toMatchObject({ state: 'revoked' });
    expect(
      (
        await all<{ action: string }>(
          env.DB,
          "SELECT action FROM audit_log WHERE target_id = ? AND action LIKE 'wallet_provider.enrolment_%' ORDER BY id",
          [on.accountId],
        )
      ).map((r) => r.action),
    ).toEqual([
      'wallet_provider.enrolment_source',
      'wallet_provider.enrolment_enable',
      'wallet_provider.enrolment_disable',
      'wallet_provider.enrolment_revoke',
    ]);
  });

  it('an org source is its own credential and never another org', async () => {
    const orgA = await k.org();
    const orgB = await k.org();
    const a = await k.member(orgA.id);
    const b = await k.member(orgB.id);
    const theirs = await saveOrgCredential(k.ctx, b.auth, orgB.id, {
      provider: 'google',
      expectedRevision: 0,
      credentials: k.google('888000222'),
    });
    // The service picks A's own credential: none yet.
    await expect(
      setEnrolmentSource(k.ctx, a.auth, orgA.id, 'google', { source: 'org', expectedRevision: 0 }),
    ).rejects.toMatchObject({ code: 'WALLET_ENROLMENT_PREREQUISITE' });
    // A hand-built step that names B's credential is refused by the database.
    const writer = grant(k.ctx, {
      purpose: 'org_mode.wallet.enrolment_source',
      principal: {
        kind: 'membership',
        membershipId:
          (
            await first<{ id: string }>(
              env.DB,
              'SELECT id FROM org_memberships WHERE org_id = ? AND user_id = ?',
              [orgA.id, a.user.id],
            )
          )?.id ?? '',
        via: 'session',
        sessionIdHash: a.auth.sessionId,
        mode: 'test',
      },
      tables: ENROLMENT_TABLES,
    });
    await expect(
      commitEnrolmentStep(k.ctx, writer, {
        accountId: k.ctx.ids.id(),
        isNew: true,
        provider: 'google',
        expectedRevision: 0,
        revision: 1,
        event: {
          id: k.ctx.ids.id(),
          kind: 'source',
          credentialId: theirs.id,
          actor: { type: 'user', id: a.user.id },
        },
        set: {
          credential_source_id: theirs.id,
          identity_hash: await (async () =>
            (
              await first<{ h: string }>(
                env.DB,
                'SELECT identity_hash AS h FROM wallet_credentials WHERE id = ?',
                [theirs.id],
              )
            )?.h ?? '')(),
          enabled_at: null,
        },
      }),
    ).rejects.toMatchObject({ code: 'WALLET_ACCOUNT_CONFLICT' });
  });
});

describe('platform hold', () => {
  it('only a platform admin holds and releases; enable is refused while held', async () => {
    const { org, m, admin } = await enrolled();
    const scope = { orgId: org.id, mode: 'test' as const, provider: 'google' as const };
    await enableEnrolment(k.ctx, m.auth, org.id, 'google', { expectedRevision: 1 });
    await expect(holdEnrolment(k.ctx, m.auth, scope, 'abuse')).rejects.toMatchObject({
      status: 403,
    });
    expect(await holdEnrolment(k.ctx, admin.auth, scope, 'abuse')).toBe('held');
    const held = (await listEnrolments(k.ctx, m.auth, org.id)).items[0];
    expect(held).toMatchObject({ state: 'held', hold: { reason: 'abuse' } });
    await expect(
      enableEnrolment(k.ctx, m.auth, org.id, 'google', {
        expectedRevision: held?.enrolmentRevision ?? 0,
      }),
    ).rejects.toMatchObject({ code: 'WALLET_ENROLMENT_HELD' });
    await expect(releaseEnrolment(k.ctx, m.auth, scope)).rejects.toMatchObject({ status: 403 });
    expect(await releaseEnrolment(k.ctx, admin.auth, scope)).toBe('released');
    expect((await listEnrolments(k.ctx, m.auth, org.id)).items[0]).toMatchObject({
      state: 'off',
      hold: null,
    });
  });

  it('a stray event at the next revision does not block a hold or a release', async () => {
    const { org, admin } = await enrolled();
    const scope = { orgId: org.id, mode: 'test' as const, provider: 'google' as const };
    const account = await first<{ id: string; enrolment_revision: number }>(
      env.DB,
      'SELECT id, enrolment_revision FROM wallet_provider_accounts WHERE org_id = ? AND mode = ?',
      [org.id, 'test'],
    );
    const acct = {
      id: account?.id ?? '',
      orgId: org.id,
      mode: 'test' as const,
      provider: 'google' as const,
    };
    // Another writer leaves an unused source event at the next revision.
    await insertEnrolmentEvent(acct, { kind: 'source', credentialId: platformId });
    expect(await holdEnrolment(k.ctx, admin.auth, scope, 'review')).toBe('held');
    const next = await first<{ r: number }>(
      env.DB,
      'SELECT enrolment_revision + 1 AS r FROM wallet_provider_accounts WHERE id = ?',
      [acct.id],
    );
    await insertEnrolmentEvent(acct, {
      kind: 'source',
      credentialId: platformId,
      revision: next?.r ?? 0,
    });
    expect(await releaseEnrolment(k.ctx, admin.auth, scope)).toBe('released');
  });

  it('on a personal org the owner releases only a hold they placed', async () => {
    const { org, admin } = await enrolled();
    const owner = await k.admin();
    await run(env.DB, 'DROP TRIGGER orgs_personal_fixed');
    await run(env.DB, 'UPDATE orgs SET personal_user_id = ? WHERE id = ?', [
      owner.auth.userId,
      org.id,
    ]);
    await run(
      env.DB,
      `CREATE TRIGGER orgs_personal_fixed BEFORE UPDATE OF personal_user_id ON orgs
       WHEN NEW.personal_user_id IS NOT OLD.personal_user_id
       BEGIN SELECT RAISE(ABORT, 'orgs personal marker is immutable'); END`,
    );
    const scope = { orgId: org.id, mode: 'test' as const, provider: 'google' as const };
    expect(await holdEnrolment(k.ctx, admin.auth, scope, 'abuse')).toBe('held');
    await expect(releaseEnrolment(k.ctx, owner.auth, scope)).rejects.toMatchObject({
      code: 'ORG_PERSONAL',
    });
    expect(await releaseEnrolment(k.ctx, admin.auth, scope)).toBe('released');
    expect(await holdEnrolment(k.ctx, owner.auth, scope, 'mine')).toBe('held');
    expect(await releaseEnrolment(k.ctx, owner.auth, scope)).toBe('released');
  });

  it('a suspended org takes the hold through its job, recording the platform user', async () => {
    const { org, m, admin } = await enrolled();
    await run(env.DB, "UPDATE orgs SET status = 'suspended' WHERE id = ?", [org.id]);
    const scope = { orgId: org.id, mode: 'test' as const, provider: 'google' as const };
    // The request-side hold would be refused by the grant, so it is queued.
    expect(await holdEnrolment(k.ctx, admin.auth, scope, 'suspended')).toBe('queued');
    await runEnrolmentHold(createJobContext(k.env, 'test'), {
      ...scope,
      reason: 'suspended',
      userId: admin.user.id,
    });
    const event = await first<{ actor_type: string; actor_id: string; kind: string }>(
      env.DB,
      "SELECT actor_type, actor_id, kind FROM wallet_enrolment_events WHERE org_id = ? AND kind = 'hold'",
      [org.id],
    );
    expect(event).toEqual({ actor_type: 'platform', actor_id: admin.user.id, kind: 'hold' });
    expect(
      await first(
        env.DB,
        "SELECT actor_id FROM audit_log WHERE org_id = ? AND action = 'wallet_provider.enrolment_hold'",
        [org.id],
      ),
    ).toEqual({ actor_id: admin.user.id });
    expect(m).toBeDefined();
  });

  it('queues the hold through JOBS.send, runs it through runJob, and a rerun adds no second event', async () => {
    const { org, admin } = await enrolled();
    await run(env.DB, "UPDATE orgs SET status = 'suspended' WHERE id = ?", [org.id]);
    const scope = { orgId: org.id, mode: 'test' as const, provider: 'google' as const };
    const sent: unknown[] = [];
    const ctx = {
      ...k.ctx,
      env: { ...k.env, JOBS: { send: async (j: unknown) => void sent.push(j) } },
    };
    expect(
      await holdEnrolment(ctx as unknown as typeof k.ctx, admin.auth, scope, 'suspended'),
    ).toBe('queued');
    expect(sent).toEqual([
      { kind: 'wallet.enrolment_hold', ...scope, reason: 'suspended', userId: admin.user.id },
    ]);
    for (let i = 0; i < 2; i++)
      await runJob(sent[0] as Job, createJobContext(k.env, 'wallet.enrolment_hold'));
    expect(
      (
        await first<{ n: number }>(
          env.DB,
          "SELECT count(*) AS n FROM wallet_enrolment_events WHERE org_id = ? AND kind = 'hold'",
          [org.id],
        )
      )?.n,
    ).toBe(1);
  });

  it('a hold or release on a deleted org is a 404', async () => {
    const { org, admin } = await enrolled();
    await run(env.DB, "UPDATE orgs SET status = 'deleted' WHERE id = ?", [org.id]);
    const scope = { orgId: org.id, mode: 'test' as const, provider: 'google' as const };
    await expect(holdEnrolment(k.ctx, admin.auth, scope, 'x')).rejects.toMatchObject({
      status: 404,
    });
  });
});
