// WA1d: the migration job puts each legacy account on a credential source, atomically, with its ids unchanged.
import { env } from 'cloudflare:workers';
import { beforeAll, describe, expect, it } from 'vitest';
import { runJob } from '../../jobs/registry.ts';
import type { Job } from '../../jobs/types.ts';
import { all, first, run } from '../../platform/db.ts';
import { fromBase64Url, sha256Hex } from '../../platform/ids.ts';
import { createJobContext } from '../../platform/service-context.ts';
import { ensureCredentialRefKeyset } from '../passes/credential-keyset.ts';
import { readGoogleCallbackVerification } from './account-service.ts';
import { migrationReport, queueMigration, runCredentialMigrate } from './credential-migrate.ts';
import {
  currentIds,
  pendingAmong,
  rowsOfOrg,
  type Seeded,
  seedLegacy,
  stateOf,
} from './credential-migrate-test-fixtures.ts';
import { saveOrgCredential, savePlatformCredential } from './credential-service.ts';
import { setEnrolmentSource } from './enrolment-service.ts';
import { findAccount } from './repo-accounts.ts';
import { type Kit, kit } from './wallet-wa1b-test-fixtures.ts';

let k: Kit;
beforeAll(async () => {
  k = await kit();
}, 30_000);

const jobCtx = () => createJobContext(k.env, 'wallet.credential_migrate');
const migrate = (a: Seeded) => runCredentialMigrate(jobCtx(), a.id);
const migrateJob = (a: Seeded) =>
  runJob({ kind: 'wallet.credential_migrate', accountId: a.id } as Job, jobCtx());
const events = (id: string) =>
  all<{ kind: string; actor_type: string; enrolment_revision: number }>(
    env.DB,
    'SELECT kind, actor_type, enrolment_revision FROM wallet_enrolment_events WHERE account_id = ? ORDER BY enrolment_revision',
    [id],
  );

describe('two orgs on the platform issuer (live Google)', () => {
  it('both land on the platform source with their keys: no credential, same ids and revision', async () => {
    const admin = await k.admin();
    const platform = await savePlatformCredential(k.ctx, admin.auth, {
      mode: 'live',
      provider: 'google',
      expectedRevision: 0,
      credentials: k.google('500100200'),
    });
    const orgA = await k.org();
    const orgB = await k.org();
    const a = await seedLegacy(k, orgA.id, 'live', 'google', k.google('500100200'));
    const b = await seedLegacy(k, orgB.id, 'live', 'google', k.google('500100200'));
    expect(await pendingAmong([a.id, b.id])).toHaveLength(2);
    const before = [await currentIds(k, a), await currentIds(k, b)];
    // The second org is suspended: the migrate grant is inactive-ok.
    await run(env.DB, "UPDATE orgs SET status = 'suspended' WHERE id = ?", [orgB.id]);
    await migrateJob(a);
    await migrateJob(b);
    for (const [i, acct] of [a, b].entries()) {
      const state = await stateOf(acct.id);
      expect(state).toMatchObject({
        revision: 1,
        enrolment_revision: 1,
        credential_source_id: platform.id,
        has_hmac: 1,
        source_scope: 'platform',
      });
      expect(await rowsOfOrg(acct.orgId)).toEqual({ credentials: 0, versions: 0, events: 1 });
      expect(await events(acct.id)).toEqual([
        { kind: 'source', actor_type: 'system', enrolment_revision: 1 },
      ]);
      // Class and object ids come from the issuer and the copied key: unchanged.
      expect(await currentIds(k, acct)).toEqual(before[i]);
    }
    const copied = await readGoogleCallbackVerification(k.ctx, {
      orgId: a.orgId,
      mode: 'live',
      accountId: a.id,
      accountRevision: 1,
      credentialKeysetCommitment: await ensureCredentialRefKeyset(env.DB, k.env),
    });
    expect(copied?.objectIdHmacKey).toEqual(fromBase64Url(a.hmacKey ?? ''));
    expect((await stateOf(a.id)).identity_hash).toBe(
      (
        await first<{ h: string }>(
          env.DB,
          'SELECT identity_hash AS h FROM wallet_credentials WHERE id = ?',
          [platform.id],
        )
      )?.h,
    );
    expect(await pendingAmong([a.id, b.id])).toEqual([]);
    const audited = await first<{ n: number }>(
      env.DB,
      "SELECT count(*) AS n FROM audit_log WHERE org_id = ? AND action = 'wallet_provider.enrolment_source'",
      [a.orgId],
    );
    expect(audited?.n).toBe(1);
  });

  it('a rerun skips migrated accounts and adds nothing', async () => {
    const org = await k.org();
    const a = await seedLegacy(k, org.id, 'live', 'google', k.google('500100200'));
    expect(await migrate(a)).toBe('migrated');
    const first = await events(a.id);
    expect(await migrate(a)).toBe('skipped');
    await migrateJob(a);
    expect(await events(a.id)).toEqual(first);
    expect(await rowsOfOrg(org.id)).toEqual({ credentials: 0, versions: 0, events: 1 });
  });

  it('a migrated row refuses a switch to another issuer, and allows the same identity', async () => {
    const org = await k.org();
    const a = await seedLegacy(k, org.id, 'live', 'google', k.google('500100200'));
    await migrate(a);
    const m = await k.member(org.id, 'live');
    await saveOrgCredential(k.ctx, m.auth, org.id, {
      provider: 'google',
      expectedRevision: 0,
      credentials: k.google('999000111'),
    });
    await expect(
      setEnrolmentSource(k.ctx, m.auth, org.id, 'google', { source: 'org', expectedRevision: 1 }),
    ).rejects.toMatchObject({ code: 'WALLET_IDENTITY_IMMUTABLE' });
    expect(await stateOf(a.id)).toMatchObject({ enrolment_revision: 1, source_scope: 'platform' });
    expect((await findAccount(env.DB, a))?.revision).toBe(1);
  });
});

describe('two orgs on a shared non-platform issuer (test Google)', () => {
  it('the first gets an unverified org credential; the second is refused and reported without ids', async () => {
    const admin = await k.admin();
    const orgC = await k.org();
    const orgD = await k.org();
    const c = await seedLegacy(k, orgC.id, 'test', 'google', k.google('600300400'));
    const d = await seedLegacy(k, orgD.id, 'test', 'google', k.google('600300400'));
    expect(await migrate(c)).toBe('migrated');
    expect(await migrate(d)).toBe('refused');
    const cred = await first<{ scope: string; verified_at: number | null; revision: number }>(
      env.DB,
      'SELECT scope, verified_at, revision FROM wallet_credentials WHERE org_id = ?',
      [orgC.id],
    );
    expect(cred).toEqual({ scope: 'org', verified_at: null, revision: 1 });
    expect(await rowsOfOrg(orgD.id)).toEqual({ credentials: 0, versions: 0, events: 0 });
    expect(await stateOf(d.id)).toMatchObject({
      enrolment_revision: 0,
      credential_source_id: null,
    });
    expect(await pendingAmong([c.id, d.id])).toEqual([d.id]);
    const report = await migrationReport(k.ctx, admin.auth);
    const item = report.items.find((i) => i.accountId === d.id);
    expect(item).toMatchObject({
      state: 'refused',
      reason: 'identity_shared',
      identityShared: [{ orgId: orgC.id, mode: 'test', provider: 'google' }],
    });
    expect(JSON.stringify(report)).not.toContain('600300400');
    // Refused again on a rerun; still no credential for D.
    expect(await migrate(d)).toBe('refused');
    expect(await rowsOfOrg(orgD.id).then((r) => r.credentials)).toBe(0);
  });
});

describe('a crash leaves nothing partial (test Samsung)', () => {
  it('a batch that aborts after the credential insert rolls all of it back; the rerun completes', async () => {
    const org = await k.org();
    const a = await seedLegacy(k, org.id, 'test', 'samsung', {
      ...k.samsung('card-crash'),
      partnerId: 'P-CRASH',
    });
    await run(
      env.DB,
      `CREATE TRIGGER wa1d_crash BEFORE INSERT ON wallet_enrolment_events WHEN NEW.account_id = '${a.id}'
       BEGIN SELECT RAISE(ABORT, 'crash'); END`,
    );
    try {
      await expect(migrateJob(a)).rejects.toThrow();
    } finally {
      await run(env.DB, 'DROP TRIGGER wa1d_crash');
    }
    expect(await rowsOfOrg(org.id)).toEqual({ credentials: 0, versions: 0, events: 0 });
    expect(await stateOf(a.id)).toMatchObject({
      enrolment_revision: 0,
      credential_source_id: null,
      has_hmac: 0,
    });
    expect(await migrate(a)).toBe('migrated');
    expect(await rowsOfOrg(org.id)).toEqual({ credentials: 1, versions: 1, events: 1 });
    const version = await first<{ card_map: string }>(
      env.DB,
      'SELECT v.card_map FROM wallet_credential_versions v JOIN wallet_credentials c ON c.id = v.credential_id WHERE c.org_id = ?',
      [org.id],
    );
    expect(JSON.parse(version?.card_map ?? '{}')).toEqual({
      generic: await sha256Hex('card-crash'),
    });
    expect(await migrate(a)).toBe('skipped');
    expect(await rowsOfOrg(org.id)).toEqual({ credentials: 1, versions: 1, events: 1 });
  });
});

describe('queueing', () => {
  it('queues one job per pending account for a platform admin only', async () => {
    const org = await k.org();
    const a = await seedLegacy(k, org.id, 'live', 'google', k.google('412341234'));
    const sent: { body: { accountId: string } }[] = [];
    const ctx = {
      ...k.ctx,
      env: {
        ...k.env,
        JOBS: { sendBatch: async (m: typeof sent) => void sent.push(...m) },
      },
    } as unknown as typeof k.ctx;
    const admin = await k.admin();
    expect(await queueMigration(ctx, admin.auth)).toBeGreaterThan(0);
    expect(sent.map((m) => m.body.accountId)).toContain(a.id);
    const member = await k.member(org.id, 'live');
    await expect(queueMigration(ctx, member.auth)).rejects.toMatchObject({ status: 403 });
    await expect(migrationReport(ctx, member.auth)).rejects.toMatchObject({ status: 403 });
  });
});
