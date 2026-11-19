// WA1a review round 1: each case is a path the review found, and fails on the 0112 that preceded the fix.
import { describe, expect, it } from 'vitest';
import { withoutTrigger } from '../../../../test/helpers/index.ts';
import { first, run, stmt } from '../../platform/db.ts';
import {
  addCheck,
  credential,
  db,
  granted,
  insertCredential,
  refused,
  revokeCredential,
  seedOrg,
  uid,
} from './repo-wallet-credentials-test-fixtures.ts';
import {
  type Acct,
  enrolment,
  enrolmentRevision,
  hold,
  insertEnrolmentEvent,
  release,
  revokeEnrolment,
  setSource,
} from './repo-wallet-enrolments-test-fixtures.ts';

/** A writer of the org that holds an org purpose of its own: it names no hold or release. */
const orgWriter = (a: Acct) => ({
  purpose: 'org_mode.wallet.enrolment_enable',
  principal: 'membership:m1',
  orgId: a.orgId,
  mode: a.mode,
});

const jobGrant = (a: Acct, purpose: string) => ({
  purpose,
  principal: 'system:wallet-job',
  orgId: a.orgId,
  mode: a.mode,
});

async function sourced() {
  const { org } = await seedOrg();
  const a = await enrolment(org.id);
  const c = await credential({ orgId: org.id });
  await setSource(a, c);
  return { org, a, c };
}

const holdAt = (a: Acct) =>
  first<{ at: number | null }>(
    db(),
    'SELECT platform_hold_at AS at FROM wallet_provider_accounts WHERE id = ?',
    [a.id],
  );

describe('H1: hold, release and checks are the platform and the check job in the database', () => {
  it('an org writer cannot release a hold, and the hold stays', async () => {
    const { a } = await sourced();
    await hold(a);
    const held = await holdAt(a);
    expect(held?.at).not.toBeNull();
    const re = /hold and release are the platform/;
    await refused(release(a, orgWriter(a)), re);
    await refused(release(a, null), re);
    await refused(release(a, { ...orgWriter(a), orgId: uid() }), re);
    await refused(release(a, jobGrant(a, 'org_mode.job.wallet.enrolment_hold')), re);
    // The hold purpose does not release, even held by a platform admin.
    await refused(
      release(a, {
        ...orgWriter(a),
        purpose: 'org_mode.wallet.enrolment_hold',
        principal: 'platform:u1',
      }),
      re,
    );
    expect(await holdAt(a)).toEqual(held);
    await release(a);
    expect(await holdAt(a)).toEqual({ at: null });
  });

  it('an org writer cannot place a hold; the hold job and a platform admin can', async () => {
    const { a } = await sourced();
    await refused(hold(a, 'x', orgWriter(a)), /hold and release are the platform/);
    await refused(hold(a, 'x', null), /hold and release are the platform/);
    expect(await holdAt(a)).toEqual({ at: null });
    await hold(a, 'abuse', jobGrant(a, 'org_mode.job.wallet.enrolment_hold'));
    expect((await holdAt(a))?.at).not.toBeNull();
    const b = (await sourced()).a;
    await hold(b);
    expect((await holdAt(b))?.at).not.toBeNull();
  });

  it('the three platform-admin purposes are refused for any other principal', async () => {
    const { a } = await sourced();
    for (const purpose of [
      'org_mode.wallet.enrolment_hold',
      'org_mode.wallet.enrolment_release',
      'org_mode.wallet.migration_resolve',
    ]) {
      const re = /held by a platform admin/;
      await refused(granted({ ...orgWriter(a), purpose }, []), re);
      await refused(granted({ ...orgWriter(a), purpose, principal: 'api_key:k1' }, []), re);
      await refused(granted({ ...orgWriter(a), purpose, principal: 'system:job' }, []), re);
      await granted({ ...orgWriter(a), purpose, principal: 'platform:u1' }, []);
    }
  });

  it('a check needs the check job grant in its batch', async () => {
    const { a, c } = await sourced();
    const version = (
      await first<{ v: string }>(
        db(),
        'SELECT current_version_id AS v FROM wallet_credentials WHERE id = ?',
        [c.id],
      )
    )?.v;
    const check = () =>
      stmt(
        db(),
        'INSERT INTO wallet_credential_checks (id, credential_id, version_id, ok) VALUES (?, ?, ?, 1)',
        [uid(), c.id, version ?? ''],
      );
    const re = /written by the check job/;
    await refused(check().run(), re);
    await refused(granted(orgWriter(a), [check()]), re);
    await refused(
      granted({ purpose: 'platform.wallet.credential_save', principal: 'platform:u1' }, [check()]),
      re,
    );
    await addCheck(c.id, version ?? '');
  });
});

describe('M1: a stray event cannot freeze an enrolment', () => {
  it('a hold skips the unused revision, and the release after it advances', async () => {
    const { a } = await sourced();
    const at = await enrolmentRevision(a);
    // The org leaves an event at the next revision that no update ever applied.
    await insertEnrolmentEvent(a, { kind: 'disable' });
    await refused(insertEnrolmentEvent(a, { kind: 'disable' }), /UNIQUE/);
    await hold(a);
    expect(await enrolmentRevision(a)).toBe(at + 2);
    await release(a);
    expect(await enrolmentRevision(a)).toBe(at + 3);
  });

  it('a stray event at the next revision does not block a release either', async () => {
    const { a } = await sourced();
    await hold(a);
    const held = await enrolmentRevision(a);
    await insertEnrolmentEvent(a, { kind: 'disable' });
    await refused(insertEnrolmentEvent(a, { kind: 'release' }), /UNIQUE/);
    await release(a);
    expect(await enrolmentRevision(a)).toBe(held + 2);
    expect(await holdAt(a)).toEqual({ at: null });
  });

  it('an event takes the next revision; only a hold, a release and a source_revoked disable skip a gap', async () => {
    const { a, c } = await sourced();
    const next = (await enrolmentRevision(a)) + 1;
    const re = /needs the next revision/;
    await refused(insertEnrolmentEvent(a, { kind: 'disable', revision: next + 3 }), re);
    await refused(insertEnrolmentEvent(a, { kind: 'revoke', revision: next + 3 }), re);
    await refused(
      insertEnrolmentEvent(a, { kind: 'source', credentialId: c.id, revision: next + 3 }),
      re,
    );
    await refused(
      insertEnrolmentEvent(a, { kind: 'disable', reason: 'other', revision: next + 3 }),
      re,
    );
    await refused(
      insertEnrolmentEvent(a, { kind: 'disable', revision: next - 1 }),
      /UNIQUE|next revision/,
    );
    await insertEnrolmentEvent(a, {
      kind: 'disable',
      reason: 'source_revoked',
      revision: next + 3,
    });
  });

  it("a source or enable names a platform credential or its own org's, not revoked", async () => {
    const { a } = await sourced();
    const { org: other } = await seedOrg();
    const theirs = await credential({ orgId: other.id });
    const mine = await credential({ orgId: a.orgId, mode: 'test' });
    const gone = await credential({ orgId: a.orgId, provider: 'samsung' });
    await revokeCredential(gone.id);
    const re = /needs an available credential/;
    await refused(insertEnrolmentEvent(a, { kind: 'source', credentialId: theirs.id }), re);
    await refused(insertEnrolmentEvent(a, { kind: 'source', credentialId: gone.id }), re);
    const checkId = await addCheck(theirs.id, theirs.versionId);
    await refused(
      insertEnrolmentEvent(a, { kind: 'enable', credentialId: theirs.id, checkId }),
      re,
    );
    // Its own org's credential and the platform's pass this guard (the account triggers judge mode and provider).
    await insertEnrolmentEvent(a, { kind: 'source', credentialId: mine.id });
    const platform = await credential({ scope: 'platform', mode: 'test', provider: 'samsung' });
    await insertEnrolmentEvent(await enrolment(a.orgId, 'test', 'samsung'), {
      kind: 'source',
      credentialId: platform.id,
    });
  });
});

describe('L1: suspended-org job grants and enable', () => {
  it('the disable and migrate jobs write no enable, source (disable) or release', async () => {
    const { a, c } = await sourced();
    const checkId = await addCheck(c.id, c.versionId);
    const noMatch = /does not match its grant/;
    const disableJob = jobGrant(a, 'org_mode.job.wallet.enrolment_disable');
    const migrate = jobGrant(a, 'org_mode.job.wallet.credential_migrate');
    await refused(
      insertEnrolmentEvent(a, { kind: 'enable', credentialId: c.id, checkId, grant: disableJob }),
      noMatch,
    );
    await refused(
      insertEnrolmentEvent(a, { kind: 'enable', credentialId: c.id, checkId, grant: migrate }),
      noMatch,
    );
    await refused(
      insertEnrolmentEvent(a, { kind: 'source', credentialId: c.id, grant: disableJob }),
      noMatch,
    );
    await hold(a);
    await refused(release(a, disableJob), /hold and release are the platform/);
    await refused(release(a, migrate), /hold and release are the platform/);
    await release(a);
    // The migrate job does write a source.
    await insertEnrolmentEvent(a, { kind: 'source', credentialId: c.id, grant: migrate });
  });

  it('an enable on a suspended org is refused, and allowed once it is active again', async () => {
    const { org, a, c } = await sourced();
    const checkId = await addCheck(c.id, c.versionId);
    await run(db(), "UPDATE orgs SET status = 'suspended' WHERE id = ?", [org.id]);
    await refused(
      insertEnrolmentEvent(a, { kind: 'enable', credentialId: c.id, checkId }),
      /enable needs an active org/,
    );
    await run(db(), "UPDATE orgs SET status = 'active' WHERE id = ?", [org.id]);
    await insertEnrolmentEvent(a, { kind: 'enable', credentialId: c.id, checkId });
  });
});

describe('N2: a revoke needs its own purpose', () => {
  it('the disable and hold jobs and a stray grant cannot revoke; the org revoke and a migration resolution can', async () => {
    const { a } = await sourced();
    const re = /does not match its grant/;
    await refused(
      insertEnrolmentEvent(a, {
        kind: 'revoke',
        grant: jobGrant(a, 'org_mode.job.wallet.enrolment_disable'),
      }),
      re,
    );
    await refused(
      insertEnrolmentEvent(a, {
        kind: 'revoke',
        grant: jobGrant(a, 'org_mode.job.wallet.enrolment_hold'),
      }),
      re,
    );
    await refused(insertEnrolmentEvent(a, { kind: 'revoke', grant: orgWriter(a) }), re);
    await refused(insertEnrolmentEvent(a, { kind: 'revoke', grant: null }), re);
    await refused(
      insertEnrolmentEvent(a, {
        kind: 'revoke',
        grant: { ...orgWriter(a), purpose: 'org_mode.wallet.enrolment_revoke', orgId: uid() },
      }),
      re,
    );
    await insertEnrolmentEvent(a, {
      kind: 'revoke',
      grant: {
        ...orgWriter(a),
        purpose: 'org_mode.wallet.migration_resolve',
        principal: 'platform:u1',
      },
    });
  });

  it('the org revoke purpose revokes an Off enrolment', async () => {
    const { org } = await seedOrg();
    const a = await enrolment(org.id);
    await revokeEnrolment(a);
    expect(
      await first(
        db(),
        'SELECT revoked_at IS NOT NULL AS gone FROM wallet_provider_accounts WHERE id = ?',
        [a.id],
      ),
    ).toEqual({ gone: 1 });
  });
});

describe('L2: an empty credential can be revoked', () => {
  it('revokes at revision 0 and frees the slot', async () => {
    const { org } = await seedOrg();
    const empty = await insertCredential({ orgId: org.id });
    await revokeCredential(empty.id);
    expect(
      await first(
        db(),
        'SELECT revision AS r, current_version_id AS v, revoked_at IS NOT NULL AS gone FROM wallet_credentials WHERE id = ?',
        [empty.id],
      ),
    ).toEqual({ r: 1, v: null, gone: 1 });
    // The slot is free for the next credential of the org, mode and provider.
    await credential({ orgId: org.id });
  });

  it('an active credential past revision 0 needs a version, and revision 0 holds none', async () => {
    const { org } = await seedOrg();
    const empty = await insertCredential({ orgId: org.id, mode: 'test' });
    await refused(
      withoutTrigger(db(), 'wallet_credentials_step', () =>
        run(db(), 'UPDATE wallet_credentials SET revision = 1 WHERE id = ?', [empty.id]),
      ),
      /CHECK constraint failed/,
    );
    const full = await credential({ orgId: org.id, provider: 'samsung' });
    await refused(
      withoutTrigger(db(), 'wallet_credentials_step', () =>
        run(db(), 'UPDATE wallet_credentials SET revision = 0 WHERE id = ?', [full.id]),
      ),
      /CHECK constraint failed/,
    );
  });
});

describe('L4: an enrolment is not inserted revoked', () => {
  it('refuses a row that already carries revoked_at, so it takes no slot', async () => {
    const { org } = await seedOrg();
    await refused(
      run(
        db(),
        "INSERT INTO wallet_provider_accounts (id, org_id, mode, provider, revoked_at, created_at, updated_at) VALUES (?, ?, 'live', 'google', 5, 1, 1)",
        [uid(), org.id],
      ),
      /starts without a source/,
    );
  });
});
