// TURN-0: each provider and mode opens alone, in code (RELEASE) and in the database (wallet_provider_releases), and
// draining keeps every issuance path shut while revokes run. The 0229 guards are exercised with their real bodies.
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { makeOrg, makePass, makeTemplate, withoutTrigger } from '../../../../test/helpers/index.ts';
import { all, first, run } from '../../platform/db.ts';
import { ensureCredentialRefKeyset } from '../passes/credential-keyset.ts';
import { savePlatformCredential } from './credential-service.ts';
import { enableEnrolment, setEnrolmentSource } from './enrolment-service.ts';
import { seedLegacyAccount } from './legacy-on-test-fixtures.ts';
import {
  setWalletReleaseForTest,
  walletProviderDisabledReason,
  walletProviderEnabled,
  walletProviderEnabledSql,
  walletProviderReleaseReason,
  walletProviderRevokes,
} from './provider-policy.ts';
import type { WalletReleaseState } from './release.ts';
import { addCheck } from './repo-wallet-credentials-test-fixtures.ts';
import { type Kit, kit, type Mode } from './wallet-wa1b-test-fixtures.ts';

type Provider = 'google' | 'samsung';
const PAIRS = [
  ['google', 'test'],
  ['google', 'live'],
  ['samsung', 'test'],
  ['samsung', 'live'],
] as const satisfies readonly (readonly [Provider, Mode])[];
const same = (a: readonly [Provider, Mode], b: readonly [Provider, Mode]) =>
  a[0] === b[0] && a[1] === b[1];

let k: Kit;
let keyset: string;
let undo: (() => void) | null = null;
beforeAll(async () => {
  k = await kit();
  keyset = await ensureCredentialRefKeyset(k.env.DB, k.env);
}, 30_000);
afterEach(async () => {
  undo?.();
  undo = null;
  // Back to the seed: dark everywhere. Copies made by a test stay, so the dark rule is lifted for the reset only.
  await withoutTrigger(k.env.DB, 'wallet_provider_releases_dark_retired', () =>
    run(k.env.DB, "UPDATE wallet_provider_releases SET state = 'dark', changed_at = 0"),
  );
});

/** Both sides of the release for one pair, as a flip migration and its RELEASE cell would set them. */
async function release(provider: Provider, mode: Mode, state: WalletReleaseState) {
  undo?.();
  undo = setWalletReleaseForTest(state, { provider, mode });
  await run(
    k.env.DB,
    'UPDATE wallet_provider_releases SET state = ?, changed_at = 1 WHERE provider = ? AND mode = ?',
    [state, provider, mode],
  );
}

const sqlOpen = async () =>
  (
    await all<{ provider: Provider; mode: Mode; open: number }>(
      k.env.DB,
      `SELECT q.provider, q.mode, ${walletProviderEnabledSql('q.provider', 'q.mode')} AS open
       FROM (SELECT 'google' AS provider, 'test' AS mode UNION ALL SELECT 'google', 'live'
         UNION ALL SELECT 'samsung', 'test' UNION ALL SELECT 'samsung', 'live') q`,
    )
  )
    .filter((r) => r.open)
    .map((r) => `${r.provider}:${r.mode}`);

/** A ready placeholder (no account) on a fresh pass, or the guard's refusal. */
async function placeholder(provider: Provider, mode: Mode): Promise<string> {
  const org = await k.org();
  const pass = await makePass(k.f, { orgId: org.id, template: makeTemplate().resolved, mode });
  const id = crypto.randomUUID();
  await run(
    k.env.DB,
    `INSERT INTO wallet_provider_instances (id, pass_id, org_id, mode, provider, credential_generation, lifecycle,
       desired_version, created_at, updated_at, credential_keyset_commitment)
     VALUES (?, ?, ?, ?, ?, 1, 'ready', 0, 1, 1, ?)`,
    [id, pass.id, org.id, mode, provider, keyset],
  );
  return id;
}

const offer = (instanceId: string) =>
  run(
    k.env.DB,
    `INSERT INTO wallet_provider_offer_refs (ref_hash, instance_id, operation_version, created_at, expires_at)
     VALUES (?, ?, 1, 1, 2)`,
    [crypto.randomUUID().replaceAll('-', '').padEnd(64, '0'), instanceId],
  );
const samsungRef = (instanceId: string) =>
  run(
    k.env.DB,
    `INSERT INTO wallet_samsung_fetch_refs (id, ref_hash, instance_id, created_at, last_offered_at,
       initial_expires_at, kek_version, iv, wrapped_dek, ciphertext)
     VALUES (?, ?, ?, 1, 1, 2, 1, x'00', x'00', x'00')`,
    [crypto.randomUUID(), crypto.randomUUID().replaceAll('-', '').padEnd(64, '0'), instanceId],
  );
const activate = (instanceId: string) =>
  run(k.env.DB, "UPDATE wallet_provider_instances SET lifecycle = 'active' WHERE id = ?", [
    instanceId,
  ]);
const operation = (instanceId: string, kind: 'upsert' | 'revoke') =>
  run(
    k.env.DB,
    `INSERT INTO wallet_provider_instance_operations (id, instance_id, version, kind, request_hash, pass_version,
       pass_revision, pass_credential_generation, lifecycle_generation, issuing_release_id, projection_release_id,
       account_revision, adapter_revision, policy_revision, created_at, credential_keyset_commitment)
     SELECT ?, i.id, 1, ?, ?, p.version, p.revision, p.credential_generation, p.lifecycle_generation, p.release_id,
       NULL, 1, 1, 1, 1, i.credential_keyset_commitment
     FROM wallet_provider_instances i JOIN passes p ON p.id = i.pass_id WHERE i.id = ?`,
    [crypto.randomUUID(), kind, 'c'.repeat(64), instanceId],
  );
/** A copy inserted active with no approved release behind it. */
async function bareActive(provider: Provider, mode: Mode) {
  const org = await k.org();
  const pass = await makePass(k.f, { orgId: org.id, template: makeTemplate().resolved, mode });
  return run(
    k.env.DB,
    `INSERT INTO wallet_provider_instances (id, pass_id, org_id, mode, provider, credential_generation, lifecycle,
       desired_version, created_at, updated_at, credential_keyset_commitment)
     VALUES (?, ?, ?, ?, ?, 1, 'active', 1, 1, 1, ?)`,
    [crypto.randomUUID(), pass.id, org.id, mode, provider, keyset],
  );
}
const refusal = (p: Promise<unknown>) =>
  p.then(
    () => null,
    (e: unknown) => String(e instanceof Error ? `${e.message} ${String(e.cause ?? '')}` : e),
  );

describe('the code gate opens one pair at a time', () => {
  it.each(PAIRS)('%s %s', async (provider, mode) => {
    await release(provider, mode, 'released');
    for (const q of PAIRS) {
      const open = same(q, [provider, mode]);
      expect(walletProviderReleaseReason(q[0], q[1]), q.join(' ')).toBe(
        open ? null : 'not_released',
      );
      expect(walletProviderRevokes(q[0], q[1]), q.join(' ')).toBe(open);
    }
    expect(walletProviderEnabled(provider)).toBe(true);
    expect(walletProviderEnabled(provider === 'google' ? 'samsung' : 'google')).toBe(false);
    expect(await sqlOpen()).toEqual([`${provider}:${mode}`]);
    // Draining: nothing is released, the revoke path alone stays open.
    await release(provider, mode, 'draining');
    for (const q of PAIRS) {
      expect(walletProviderReleaseReason(q[0], q[1])).toBe('not_released');
      expect(walletProviderRevokes(q[0], q[1])).toBe(same(q, [provider, mode]));
    }
    expect(await sqlOpen()).toEqual([]);
  });
});

describe('the database guards open one pair at a time', () => {
  it.each(PAIRS)('%s %s', async (provider, mode) => {
    await release(provider, mode, 'released');
    for (const q of PAIRS) {
      const open = same(q, [provider, mode]);
      if (!open) {
        expect(await refusal(placeholder(q[0], q[1])), q.join(' ')).toContain(
          'provider issuance is unavailable',
        );
        continue;
      }
      const id = await placeholder(q[0], q[1]);
      // Released, a copy inserted active still needs an approved release naming its account (0207's proof).
      expect(await refusal(bareActive(q[0], q[1]))).toContain('provider issuance is unavailable');
      // Released: the guards let these through; the table rules (an active copy needs an account) still hold.
      expect(await refusal(activate(id))).not.toContain('provider issuance is unavailable');
      expect(await refusal(offer(id))).toBeNull();
      expect(await refusal(samsungRef(id))).toBeNull();
      // Draining shuts them again, and a served offer can no longer be redeemed.
      await release(provider, mode, 'draining');
      expect(await refusal(placeholder(q[0], q[1]))).toContain('provider issuance is unavailable');
      expect(await refusal(activate(id))).toContain('provider issuance is unavailable');
      expect(await refusal(offer(id))).toContain('provider offer is unavailable');
      expect(await refusal(samsungRef(id))).toContain('provider reference is unavailable');
      // Only a revoke may be queued while draining: no update, no message's upsert.
      expect(await refusal(operation(id, 'upsert'))).toContain('provider is draining');
      expect(String(await refusal(operation(id, 'revoke')))).not.toContain('draining');
      expect(
        await refusal(
          run(
            k.env.DB,
            'UPDATE wallet_provider_offer_refs SET consumed_at = 1 WHERE instance_id = ?',
            [id],
          ),
        ),
      ).toContain('provider offer is unavailable');
      // A placeholder never reached a wallet, so it does not hold the release open (0229 M4).
      expect(await refusal(release(provider, mode, 'dark'))).toBeNull();
    }
  });

  it('keeps the keyset rule when released', async () => {
    await release('google', 'test', 'released');
    const org = await k.org();
    const pass = await makePass(k.f, {
      orgId: org.id,
      template: makeTemplate().resolved,
      mode: 'test',
    });
    expect(
      await refusal(
        run(
          k.env.DB,
          `INSERT INTO wallet_provider_instances (id, pass_id, org_id, mode, provider, credential_generation, lifecycle,
             desired_version, created_at, updated_at, credential_keyset_commitment)
           VALUES (?, ?, ?, 'test', 'google', 1, 'ready', 0, 1, 1, ?)`,
          [crypto.randomUUID(), pass.id, org.id, 'f'.repeat(64)],
        ),
      ),
    ).toContain('provider issuance is unavailable');
    expect(
      await first(k.env.DB, "SELECT 1 FROM wallet_provider_releases WHERE state = 'released'"),
    ).not.toBeNull();
  });
});

describe('the org layer behind one released pair', () => {
  it('issues only for an org On in that pair; the plan, developer orgs and legacy rows stay shut', async () => {
    const admin = await k.admin('test');
    const saved = await savePlatformCredential(k.ctx, admin.auth, {
      mode: 'test',
      provider: 'google',
      expectedRevision: 0,
      credentials: k.google('777000666'),
    });
    const version = await first<{ v: string }>(
      k.env.DB,
      'SELECT current_version_id AS v FROM wallet_credentials WHERE id = ?',
      [saved.id],
    );
    const on = async (org: { id: string }) => {
      const m = await k.member(org.id, 'test');
      await setEnrolmentSource(k.ctx, m.auth, org.id, 'google', {
        source: 'platform',
        expectedRevision: 0,
      });
      await addCheck(saved.id, version?.v ?? '');
      await enableEnrolment(k.ctx, m.auth, org.id, 'google', { expectedRevision: 1 });
      return org;
    };
    const reason = (orgId: string, provider: Provider, mode: Mode) =>
      walletProviderDisabledReason(k.env.DB, provider, orgId, mode);
    await release('google', 'test', 'released');
    const open = await on(await k.org());
    expect(await reason(open.id, 'google', 'test')).toBeNull();
    expect(await reason(open.id, 'samsung', 'test')).toBe('not_released');
    expect(await reason(open.id, 'google', 'live')).toBe('not_released');
    const trial = await on(await k.org());
    await run(k.env.DB, "UPDATE org_entitlements SET preset = 'trial' WHERE org_id = ?", [
      trial.id,
    ]);
    expect(await reason(trial.id, 'google', 'test')).toBe('not_included');
    const developer = await makeOrg(k.f, { kind: 'developer' });
    expect(await reason(developer.id, 'google', 'test')).toBe('not_included');
    const legacy = await k.org();
    const lm = await k.member(legacy.id, 'test');
    await seedLegacyAccount(k.ctx, lm.auth, {
      orgId: legacy.id,
      mode: 'test',
      provider: 'google',
      expectedRevision: 0,
      credentials: k.google('777000667'),
    });
    expect(await reason(legacy.id, 'google', 'test')).toBe('not_enrolled');
    // Draining shuts the open org too.
    await release('google', 'test', 'draining');
    expect(await reason(open.id, 'google', 'test')).toBe('not_released');
  });
});
