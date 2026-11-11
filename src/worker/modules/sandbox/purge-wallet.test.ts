import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { installKeysetTestEnv } from '../../../../test/helpers/credential-keyset.ts';
import { stagePendingCredentialTransfer } from '../../../../test/helpers/credential-transfer.ts';
import {
  editFixedColumns,
  makeOrg,
  makeUser,
  type PassRow,
} from '../../../../test/helpers/index.ts';
import { createFixtureIdentity } from '../../../passkit/testing/fixture-identity.ts';
import { credentialAad, encryptSecret, loadKekRing } from '../../platform/crypto.ts';
import { first, run } from '../../platform/db.ts';
import type { AppEnv } from '../../platform/env.ts';
import { sha256Hex } from '../../platform/ids.ts';
import type { ServiceContext } from '../../platform/service-context.ts';
import { createSession, resolveSession } from '../auth/sessions.ts';
import { jobCtxOf } from '../delivery/delivery-test-fixtures.ts';
import { enqueuePassEmail } from '../delivery/issuance-intent.ts';
import { handleEmailSend } from '../delivery/jobs.ts';
import { getHolderPass } from '../holders/repo.ts';
import {
  approveAppleRelease,
  createAppleReleaseCandidate,
  grantKitMembership,
} from '../passes/apple-release-test-fixtures.ts';
import { requireCredentialRefKeyset } from '../passes/credential-keyset.ts';
import { startCredentialTransfer } from '../passes/credential-transfer.ts';
import { type Kit, setupKit, withKitDatabase } from '../passes/pass-test-fixtures.ts';
import { getPass } from '../passes/repo-read-pass.ts';
import { codeOf, key, setupScanKit } from '../scan/test-kit.ts';
import { configureWalletProviderAccount } from '../wallet-providers/account-service.ts';
import { retireWalletInstance } from '../wallet-providers/instance.ts';
import { makeProviderTestTemplate } from '../wallet-providers/offers-test-fixtures.ts';
import {
  approveProjectionCandidate,
  createProjectionCandidate,
  publishProjectionRelease,
} from '../wallet-providers/projection-service.ts';
import { setWalletProvidersEnabledForTest } from '../wallet-providers/provider-policy.ts';
import {
  seedHistoricalProviderInstance,
  seedHistoricalSamsungRef,
} from '../wallet-providers/runtime-historical-fixtures.ts';
import { refreshSamsungProjectionEvidence } from '../wallet-providers/samsung-verification.ts';
import { drainWalletProviderSync } from '../wallet-providers/sync.ts';
import { finishWalletProviderRetirement } from '../wallet-providers/sync-operation-retirement.ts';
import { purgeTestPasses } from './jobs.ts';
import { expiredTestPasses, stageExpiredTestPassRetirement } from './repo.ts';

const DAY = 86_400_000;

// Providers are gated off in production; retirement is exercised as if they were released.
// `purgeTestPasses` selects every expired Test pass, so each case needs its own D1.
const makeEnv = installKeysetTestEnv();
const testDatabase = async () => (await makeEnv()).DB;
let restoreProviders: () => void;
beforeAll(() => {
  restoreProviders = setWalletProvidersEnabledForTest(true);
});
afterAll(() => restoreProviders());
type Mode = 'live' | 'test';
type Provider = 'samsung';

interface Native {
  id: string;
  operationId: string;
  accountId: string;
  orgId: string;
  mode: Mode;
  credentialKeysetCommitment: string;
  provider: Provider;
  releaseId: string;
}

async function pass(kit: Kit, mode: Mode, createdAt: number, orgId = kit.org.id): Promise<PassRow> {
  const row = await kit.pass({ orgId, mode, holderEmail: 'private@example.test' });
  await editFixedColumns(kit.env.DB, 'passes', 'UPDATE passes SET created_at = ? WHERE id = ?', [
    createdAt,
    row.id,
  ]);
  return row;
}

const samsungProjections = new WeakMap<
  Kit,
  Map<string, Promise<{ accountId: string; releaseId: string }>>
>();

/** A provider fixture has the same independently reviewed and verified scope as an issued instance. */
async function samsungProjection(kit: Kit, row: PassRow) {
  const source = await first<{
    org_id: string;
    mode: Mode;
    template_id: string;
    template_version: string;
    release_id: string | null;
  }>(
    kit.env.DB,
    'SELECT org_id, mode, template_id, template_version, release_id FROM passes WHERE id = ?',
    [row.id],
  );
  if (!source?.release_id) throw new Error('Pass has no approved issuing release');
  let byScope = samsungProjections.get(kit);
  if (!byScope) {
    byScope = new Map();
    samsungProjections.set(kit, byScope);
  }
  const key = [
    source.org_id,
    source.mode,
    source.template_id,
    source.template_version,
    source.release_id,
  ].join(':');
  let pending = byScope.get(key);
  if (!pending) {
    pending = (async () => {
      const scope = { orgId: source.org_id, mode: source.mode, provider: 'samsung' as const };
      const user = await makeUser(kit.fx);
      await grantKitMembership(kit, scope.orgId, user.id, ['org_admin']);
      const session = await createSession(kit.ctx, {
        userId: user.id,
        roles: ['user'],
        amr: 'oidc',
        ipPrefix: null,
        userAgent: null,
      });
      const resolved = await resolveSession(kit.env, kit.clock, session.cookieValue);
      if (!resolved) throw new Error('Missing provider account session');
      const auth = { ...resolved, mode: scope.mode };
      let account = await first<{ id: string }>(
        kit.env.DB,
        "SELECT id FROM wallet_provider_accounts WHERE org_id = ? AND mode = ? AND provider = 'samsung'",
        [scope.orgId, scope.mode],
      );
      if (!account) {
        const identity = await createFixtureIdentity(undefined, { now: new Date(kit.clock.now()) });
        const configured = await configureWalletProviderAccount(kit.ctx, auth, {
          ...scope,
          expectedRevision: 0,
          credentials: {
            partnerId: 'partner',
            certificateId: 'ABCD',
            cardId: 'membership',
            partnerPrivateKeyPem: identity.privateKey,
            partnerCertificatePem: identity.certificate,
            samsungCertificatePem: identity.certificate,
          },
        });
        if (!configured.accountId) throw new Error('Missing configured account');
        account = { id: configured.accountId };
      }
      const principals = await createAppleReleaseCandidate(kit, {
        orgId: scope.orgId,
        mode: scope.mode,
        templateId: source.template_id,
        version: source.template_version,
      });
      const template = await kit.registry.resolve(source.template_id, source.template_version);
      const barcode =
        template.passJson.barcode || template.passJson.barcodes?.length
          ? ('qr' as const)
          : ('none' as const);
      const candidate = await createProjectionCandidate(
        kit.ctx,
        principals.authorAuth,
        source.template_id,
        {
          ...scope,
          version: source.template_version,
          sourceReleaseId: source.release_id!,
          projection: {
            schema: 1,
            provider: 'samsung',
            language: 'en',
            logoUrl: 'https://example.test/logo.png',
            sourceArtworkSlots: ['icon'],
            titleField: 'name',
            fields: ['name'],
            barcode,
            cardType: 'loyalty',
            cardSubType: 'others',
            countryCode: 'GB',
            appLinkLogo: 'https://example.test/app.png',
            appLinkName: 'Account',
            appLinkData: 'https://example.test/account',
          },
        },
      );
      const approval = await approveProjectionCandidate(
        kit.ctx,
        principals.reviewerAuth,
        source.template_id,
        candidate.id,
        { ...scope, candidateHash: candidate.candidateHash },
      );
      const fetcher = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
        Response.json({
          resultCode: '0',
          template: {
            cardId: 'membership',
            cardType: 'loyalty',
            subType: 'others',
            countryCode: 'GB',
            state: 'ACTIVE',
            testingModeOff: 'Y',
          },
        }),
      );
      try {
        expect(
          await refreshSamsungProjectionEvidence(kit.ctx, auth, {
            orgId: scope.orgId,
            mode: scope.mode,
            candidateId: candidate.id,
            candidateHash: candidate.candidateHash,
          }),
        ).toMatchObject({ verified: true });
      } finally {
        fetcher.mockRestore();
      }
      const current = await first<{ generation: number }>(
        kit.env.DB,
        `SELECT COALESCE(MAX(generation), 0) AS generation
        FROM template_releases WHERE template_id = ? AND org_id = ? AND mode = ? AND provider = 'samsung'`,
        [source.template_id, scope.orgId, scope.mode],
      );
      const release = await publishProjectionRelease(
        kit.ctx,
        principals.publisherAuth,
        source.template_id,
        {
          ...scope,
          candidateId: candidate.id,
          approvalId: approval.id,
          candidateHash: candidate.candidateHash,
          expectedGeneration: current?.generation ?? 0,
        },
      );
      return { accountId: account.id, releaseId: release.id };
    })();
    byScope.set(key, pending);
  }
  return pending;
}

/** Minimal durable instance; a pending revoke is kept out of the due queue until the test settles it. */
async function native(
  kit: Kit,
  row: PassRow,
  mode: Mode,
  provider: Provider,
  orgId = row.orgId,
  accountOverride?: string,
  projectionReleaseId?: string,
): Promise<Native> {
  const db = kit.env.DB;
  const scoped = projectionReleaseId
    ? {
        accountId: (
          await first<{ id: string }>(
            db,
            "SELECT id FROM wallet_provider_accounts WHERE org_id = ? AND mode = ? AND provider = 'samsung'",
            [row.orgId, mode],
          )
        )?.id,
        releaseId: projectionReleaseId,
      }
    : await samsungProjection(kit, row);
  if (!scoped.accountId) throw new Error('Missing provider account');
  const accountId = accountOverride ?? scoped.accountId;
  const id = kit.fx.ids.id();
  const operationId = kit.fx.ids.id();
  const releaseId = scoped.releaseId;
  const credentialKeysetCommitment = await requireCredentialRefKeyset(db, kit.env);
  const generation = await first<{ credential_generation: number }>(
    db,
    'SELECT credential_generation FROM passes WHERE id = ?',
    [row.id],
  );
  if (!generation) throw new Error('Missing pass generation');
  await seedHistoricalProviderInstance(db, {
    id,
    passId: row.id,
    orgId,
    mode,
    provider,
    credentialGeneration: generation.credential_generation,
    accountId,
    releaseId,
    operationId,
    now: kit.clock.now(),
    credentialKeysetCommitment,
  });
  await run(
    db,
    `INSERT INTO wallet_provider_instance_operations
    (id, instance_id, version, kind, request_hash, pass_version, pass_revision, pass_credential_generation,
     lifecycle_generation, issuing_release_id, projection_release_id, account_revision, adapter_revision, policy_revision,
     credential_keyset_commitment, state, next_attempt_at, created_at)
    SELECT ?, i.id, 1, 'revoke', ?, p.version, p.revision, p.credential_generation, p.lifecycle_generation,
      p.release_id, r.id, a.revision, r.adapter_revision, r.audience_policy_revision,
      ?, 'pending', ?, ?
    FROM wallet_provider_instances i JOIN passes p ON p.id = i.pass_id
      JOIN wallet_provider_accounts a ON a.id = i.account_id
      JOIN template_releases r ON r.id = i.identity_projection_release_id
    WHERE i.id = ? AND p.id = ?`,
    [
      operationId,
      'a'.repeat(64),
      credentialKeysetCommitment,
      kit.clock.now() + 365 * DAY,
      kit.clock.now(),
      id,
      row.id,
    ],
  );
  return {
    id,
    operationId,
    accountId,
    orgId,
    mode,
    provider,
    releaseId,
    credentialKeysetCommitment,
  };
}

const retirement = (kit: Kit, instance: Native) => ({
  instanceId: instance.id,
  orgId: instance.orgId,
  mode: instance.mode,
  provider: instance.provider,
  version: 1,
  now: kit.clock.now(),
  credentialKeysetCommitment: instance.credentialKeysetCommitment,
});

async function requestState(kit: Kit, instance: Native) {
  return first<{
    retirement_requested_at: number | null;
    lifecycle: string;
    installation_state: string;
  }>(
    kit.env.DB,
    'SELECT retirement_requested_at, lifecycle, installation_state FROM wallet_provider_instances WHERE id = ?',
    [instance.id],
  );
}

async function acceptRevoke(kit: Kit, instance: Native) {
  await run(
    kit.env.DB,
    "UPDATE wallet_provider_instance_operations SET state = 'succeeded', next_attempt_at = NULL WHERE id = ?",
    [instance.operationId],
  );
  await run(
    kit.env.DB,
    "UPDATE wallet_provider_instances SET lifecycle = 'revoking' WHERE id = ?",
    [instance.id],
  );
  await run(kit.env.DB, "UPDATE wallet_provider_instances SET lifecycle = 'revoked' WHERE id = ?", [
    instance.id,
  ]);
}

/** A historical test-mode Samsung reference, bound to a genuinely verified reviewed projection. */
async function samsungFixture() {
  const kit = await setupKit({ db: await testDatabase(), template: makeProviderTestTemplate });
  const apple = await approveAppleRelease(kit, { mode: 'test' });
  const user = await makeUser(kit.fx);
  await grantKitMembership(kit, kit.org.id, user.id, ['org_admin']);
  const session = await createSession(kit.ctx, {
    userId: user.id,
    roles: ['user'],
    amr: 'oidc',
    ipPrefix: null,
    userAgent: null,
  });
  const resolved = await resolveSession(kit.env, kit.clock, session.cookieValue);
  if (!resolved) throw new Error('Missing provider account session');
  const auth = { ...resolved, mode: 'test' as const };
  const identity = await createFixtureIdentity(undefined, { now: new Date(kit.clock.now()) });
  const scope = { orgId: kit.org.id, mode: 'test' as const, provider: 'samsung' as const };
  await configureWalletProviderAccount(kit.ctx, auth, {
    ...scope,
    expectedRevision: 0,
    credentials: {
      partnerId: 'partner',
      certificateId: 'ABCD',
      cardId: 'membership',
      partnerPrivateKeyPem: identity.privateKey,
      partnerCertificatePem: identity.certificate,
      samsungCertificatePem: identity.certificate,
    },
  });
  const candidate = await createProjectionCandidate(kit.ctx, apple.authorAuth, kit.template.id, {
    ...scope,
    version: kit.template.version,
    sourceReleaseId: apple.id,
    projection: {
      schema: 1,
      provider: 'samsung',
      language: 'en',
      logoUrl: 'https://example.test/logo.png',
      sourceArtworkSlots: ['icon'],
      titleField: 'name',
      fields: ['name'],
      barcode: 'none',
      cardType: 'loyalty',
      cardSubType: 'others',
      countryCode: 'GB',
      appLinkLogo: 'https://example.test/app.png',
      appLinkName: 'Account',
      appLinkData: 'https://example.test/account',
    },
  });
  const approval = await approveProjectionCandidate(
    kit.ctx,
    apple.reviewerAuth,
    kit.template.id,
    candidate.id,
    {
      ...scope,
      candidateHash: candidate.candidateHash,
    },
  );
  const fetcher = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    expect(url).toBe(
      'https://tsapi-card.walletsvc.samsung.com/partner/v1/card/template/membership',
    );
    expect(init?.method).toBe('GET');
    return Response.json({
      resultCode: '0',
      template: {
        cardId: 'membership',
        cardType: 'loyalty',
        subType: 'others',
        countryCode: 'GB',
        state: 'ACTIVE',
        testingModeOff: 'Y',
      },
    });
  });
  try {
    expect(
      await refreshSamsungProjectionEvidence(kit.ctx, auth, {
        orgId: kit.org.id,
        mode: 'test',
        candidateId: candidate.id,
        candidateHash: candidate.candidateHash,
      }),
    ).toMatchObject({ verified: true });
  } finally {
    fetcher.mockRestore();
  }
  const release = await publishProjectionRelease(kit.ctx, apple.publisherAuth, kit.template.id, {
    ...scope,
    candidateId: candidate.id,
    approvalId: approval.id,
    candidateHash: candidate.candidateHash,
    expectedGeneration: 0,
  });
  const row = await kit.pass({ mode: 'test', holderEmail: 'private@example.test' });
  const instance = await native(kit, row, 'test', 'samsung', kit.org.id, undefined, release.id);
  const referenceId = kit.fx.ids.id();
  const ref = kit.ctx.ids.token(24);
  const envelope = await encryptSecret(
    await loadKekRing(kit.env),
    ref,
    credentialAad(referenceId, kit.org.id, `samsung-ref|test|${instance.id}`),
  );
  await seedHistoricalSamsungRef(kit.env.DB, {
    id: referenceId,
    refHash: await sha256Hex(ref),
    instanceId: instance.id,
    createdAt: kit.clock.now(),
    initialExpiresAt: kit.clock.now() + 60_000,
    promotedAt: null,
    envelope,
    credentialKeysetCommitment: instance.credentialKeysetCommitment,
  });
  return { kit, row, instance };
}

function raceFirstBatch(ctx: ServiceContext, mutate: () => Promise<void>) {
  let invoked = false;
  const db = new Proxy(ctx.env.DB, {
    get(target, property) {
      if (property === 'batch')
        return async (statements: D1PreparedStatement[]) => {
          if (!invoked) {
            invoked = true;
            await mutate();
          }
          return target.batch(statements);
        };
      const value = Reflect.get(target, property, target);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
  const env: AppEnv = { ...ctx.env, DB: db };
  return { ctx: { ...ctx, env }, invoked: () => invoked };
}

describe('sandbox native wallet retention', () => {
  it('stages only selected expired test passes, including suspended tenants, in their own scope', async () => {
    const kit = await setupKit({ db: await testDatabase(), template: makeProviderTestTemplate });
    const before = kit.clock.now() - DAY;
    const other = await makeOrg(kit.fx);
    const old = await pass(kit, 'test', before - 10);
    const otherOld = await pass(kit, 'test', before - 9, other.id);
    const fresh = await pass(kit, 'test', before + 1);
    const boundary = await pass(kit, 'test', before);
    const live = await pass(kit, 'live', before - 20);
    const appleOnly = await pass(kit, 'test', before - 8);
    const mismatched = await pass(kit, 'test', before - 7);
    const wrongAccountPass = await pass(kit, 'test', before - 6);
    const samsung = await native(kit, old, 'test', 'samsung');
    const otherSamsung = await native(kit, otherOld, 'test', 'samsung');
    const freshSamsung = await native(kit, fresh, 'test', 'samsung');
    const boundarySamsung = await native(kit, boundary, 'test', 'samsung');
    const liveSamsung = await native(kit, live, 'live', 'samsung');
    for (const attempt of [
      { passId: mismatched.id, orgId: other.id, accountId: samsung.accountId },
      { passId: wrongAccountPass.id, orgId: kit.org.id, accountId: otherSamsung.accountId },
    ]) {
      await expect(
        run(
          kit.env.DB,
          `INSERT INTO wallet_provider_instances
        (id, pass_id, org_id, mode, provider, account_id, identity_projection_release_id,
         credential_generation, desired_version, desired_operation_id, created_at, updated_at)
        SELECT ?, id, ?, 'test', 'samsung', ?, ?, credential_generation, 1, ?, ?, ?
        FROM passes WHERE id = ?`,
          [
            kit.fx.ids.id(),
            attempt.orgId,
            attempt.accountId,
            samsung.releaseId,
            kit.fx.ids.id(),
            kit.clock.now(),
            kit.clock.now(),
            attempt.passId,
          ],
        ),
      ).rejects.toThrow();
    }
    await run(kit.env.DB, "UPDATE orgs SET status = 'suspended' WHERE id = ?", [other.id]);

    // Fixture releases may already have marked an instance dirty; staging adds exactly one.
    const dirtyGeneration = async (instanceId: string) =>
      (
        await first<{ generation: number }>(
          kit.env.DB,
          'SELECT generation FROM wallet_provider_instance_dirty WHERE instance_id = ?',
          [instanceId],
        )
      )?.generation ?? 0;
    const dirtyBefore = new Map([
      [samsung.id, await dirtyGeneration(samsung.id)],
      [otherSamsung.id, await dirtyGeneration(otherSamsung.id)],
    ]);
    expect(await purgeTestPasses(kit.ctx, before)).toBe(3);
    for (const instance of [samsung, otherSamsung]) {
      expect(await requestState(kit, instance)).toMatchObject({
        retirement_requested_at: kit.clock.now(),
        lifecycle: 'active',
        installation_state: 'unknown',
      });
      expect(await dirtyGeneration(instance.id)).toBe((dirtyBefore.get(instance.id) ?? 0) + 1);
    }
    for (const instance of [freshSamsung, boundarySamsung, liveSamsung]) {
      expect(await requestState(kit, instance)).toMatchObject({
        retirement_requested_at: null,
        lifecycle: 'active',
      });
      expect(
        await first(
          kit.env.DB,
          'SELECT generation FROM wallet_provider_instance_dirty WHERE instance_id = ?',
          [instance.id],
        ),
      ).toBeNull();
    }
    expect(await kit.env.BUCKET.head(old.objectKey)).not.toBeNull();
    expect(await kit.env.BUCKET.head(wrongAccountPass.objectKey)).toBeNull();
    expect(await kit.env.BUCKET.head(mismatched.objectKey)).toBeNull();
    expect(
      await first(kit.env.DB, 'SELECT id FROM passes WHERE id = ?', [appleOnly.id]),
    ).toBeNull();
    expect(await kit.env.BUCKET.head(appleOnly.objectKey)).toBeNull();
  }, 60_000);

  it('rechecks age at the transaction boundary after the real purge selected a pass', async () => {
    const kit = await setupKit({ db: await testDatabase(), template: makeProviderTestTemplate });
    const before = kit.clock.now() - DAY;
    const row = await pass(kit, 'test', before - 1);
    const instance = await native(kit, row, 'test', 'samsung');
    const race = raceFirstBatch(kit.ctx, () =>
      editFixedColumns(kit.env.DB, 'passes', 'UPDATE passes SET created_at = ? WHERE id = ?', [
        before + 1,
        row.id,
      ]).then(() => undefined),
    );
    expect(await purgeTestPasses(race.ctx, before)).toBe(0);
    expect(race.invoked()).toBe(true);
    expect(await requestState(kit, instance)).toMatchObject({ retirement_requested_at: null });
    expect(
      await first(
        kit.env.DB,
        'SELECT generation FROM wallet_provider_instance_dirty WHERE instance_id = ?',
        [instance.id],
      ),
    ).toBeNull();
    expect(await kit.env.BUCKET.head(row.objectKey)).not.toBeNull();
  }, 60_000);

  it('fails closed before selecting or staging retirement with a different credential keyset', async () => {
    const kit = await setupKit({ db: await testDatabase(), template: makeProviderTestTemplate });
    const before = kit.clock.now() - DAY;
    const row = await pass(kit, 'test', before - 1);
    const instance = await native(kit, row, 'test', 'samsung');
    const alternate = btoa(String.fromCharCode(...new Uint8Array(32).fill(7)));
    const wrongKey =
      alternate === kit.env.KEK_V1
        ? btoa(String.fromCharCode(...new Uint8Array(32).fill(8)))
        : alternate;
    const ctx = { ...kit.ctx, env: { ...kit.env, KEK_V1: wrongKey } };
    await expect(purgeTestPasses(ctx, before)).rejects.toMatchObject({
      code: 'CREDENTIAL_REF_KEYSET_UNAVAILABLE',
    });
    expect(await requestState(kit, instance)).toMatchObject({ retirement_requested_at: null });
    expect(
      await first(
        kit.env.DB,
        'SELECT generation FROM wallet_provider_instance_dirty WHERE instance_id = ?',
        [instance.id],
      ),
    ).toBeNull();
    expect(await first(kit.env.DB, 'SELECT id FROM passes WHERE id = ?', [row.id])).not.toBeNull();
    expect(await kit.env.BUCKET.head(row.objectKey)).not.toBeNull();
  }, 60_000);

  it('keeps the pass if a provider instance appears after selection but before deletion', async () => {
    const kit = await setupKit({ db: await testDatabase(), template: makeProviderTestTemplate });
    const before = kit.clock.now() - DAY;
    const row = await pass(kit, 'test', before - 1);
    await samsungProjection(kit, row);
    let instance: Native | undefined;
    const race = raceFirstBatch(kit.ctx, async () => {
      instance = await native(kit, row, 'test', 'samsung');
    });
    expect(await purgeTestPasses(race.ctx, before)).toBe(0);
    expect(race.invoked()).toBe(true);
    if (!instance) throw new Error('Expected late provider instance');
    expect(await requestState(kit, instance)).toMatchObject({ retirement_requested_at: null });
    expect(await first(kit.env.DB, 'SELECT id FROM passes WHERE id = ?', [row.id])).not.toBeNull();
    expect(await kit.env.BUCKET.head(row.objectKey)).not.toBeNull();
    expect(await purgeTestPasses(kit.ctx, before)).toBe(0);
    expect(await requestState(kit, instance)).toMatchObject({
      retirement_requested_at: kit.clock.now(),
    });
  }, 60_000);

  it('does not stage stale keyset, revision, transfer, link or forwarding-reserved snapshots', async () => {
    const kit = await setupKit({ db: await testDatabase(), template: makeProviderTestTemplate });
    const before = kit.clock.now() - DAY;
    for (const mutation of ['revision', 'link', 'transfer', 'lifecycle', 'keyset'] as const) {
      const row = await pass(kit, 'test', before - 1);
      const instance = await native(kit, row, 'test', 'samsung');
      const selected = (await expiredTestPasses(kit.env.DB, before, 100)).find(
        (item) => item.id === row.id,
      );
      if (!selected) throw new Error('Expected selected pass');
      if (mutation === 'transfer') {
        await stagePendingCredentialTransfer(kit.env.DB, row.id, {
          id: kit.fx.ids.id(),
          token: kit.ctx.ids.token(),
          now: kit.clock.now(),
          targetHolderEmail: 'next@example.test',
        });
      } else if (mutation !== 'keyset') {
        const column =
          mutation === 'revision'
            ? 'revision'
            : mutation === 'link'
              ? 'link_generation'
              : 'lifecycle_generation';
        await run(kit.env.DB, `UPDATE passes SET ${column} = ${column} + 1 WHERE id = ?`, [row.id]);
      }
      const state = await requestState(kit, instance);
      expect(state).toMatchObject({
        retirement_requested_at: mutation === 'transfer' ? kit.clock.now() : null,
      });
      const dirty = await first(
        kit.env.DB,
        'SELECT generation, next_attempt_at FROM wallet_provider_instance_dirty WHERE instance_id = ?',
        [instance.id],
      );
      const keyset =
        mutation === 'keyset'
          ? (instance.credentialKeysetCommitment === 'f'.repeat(64) ? 'e' : 'f').repeat(64)
          : instance.credentialKeysetCommitment;
      await stageExpiredTestPassRetirement(kit.env.DB, selected, before, kit.clock.now(), keyset);
      expect(await requestState(kit, instance)).toEqual(state);
      expect(
        await first(
          kit.env.DB,
          'SELECT generation, next_attempt_at FROM wallet_provider_instance_dirty WHERE instance_id = ?',
          [instance.id],
        ),
      ).toEqual(dirty);
    }
    const liveRow = await pass(kit, 'live', before - 1);
    const liveInstance = await native(kit, liveRow, 'live', 'samsung');
    const livePass = await getPass(kit.env.DB, liveRow.id);
    if (!livePass) throw new Error('Expected live pass');
    expect(
      (await expiredTestPasses(kit.env.DB, before, 100)).some((item) => item.id === liveRow.id),
    ).toBe(false);
    await stageExpiredTestPassRetirement(
      kit.env.DB,
      { ...livePass, providerRetirementNeeded: true, providerRetirementComplete: false },
      before,
      kit.clock.now(),
      liveInstance.credentialKeysetCommitment,
    );
    expect(await requestState(kit, liveInstance)).toMatchObject({ retirement_requested_at: null });
    expect(
      await first(
        kit.env.DB,
        'SELECT generation FROM wallet_provider_instance_dirty WHERE instance_id = ?',
        [liveInstance.id],
      ),
    ).toBeNull();

    const reserved = await kit.pass({ mode: 'test' });
    await editFixedColumns(kit.env.DB, 'passes', 'UPDATE passes SET created_at = ? WHERE id = ?', [
      before - 1,
      reserved.id,
    ]);
    const instance = await native(kit, reserved, 'test', 'samsung');
    const { outboxId } = await enqueuePassEmail(jobCtxOf(kit), {
      passId: reserved.id,
      to: 'holder@example.test',
      attach: false,
      expected: reserved,
    });
    await handleEmailSend({ kind: 'email.send', outboxId }, jobCtxOf(kit));
    const capture = await first<{ id: string }>(
      kit.env.DB,
      'SELECT id FROM captured_emails WHERE outbox_id = ?',
      [outboxId],
    );
    if (!capture) throw new Error('Expected capture');
    const selected = (await expiredTestPasses(kit.env.DB, before, 100)).find(
      (item) => item.id === reserved.id,
    );
    if (!selected) throw new Error('Expected selected pass');
    const actor = await makeUser(kit.fx);
    await run(
      kit.env.DB,
      `INSERT INTO sandbox_forwards
      (id, capture_id, org_id, actor_id, email, intent, pass_ids, state, created_at, lease_until)
      VALUES (?, ?, ?, ?, ?, 'intent', ?, 'sending', ?, ?)`,
      [
        kit.fx.ids.id(),
        capture.id,
        kit.org.id,
        actor.id,
        actor.primaryEmail,
        JSON.stringify([reserved.id]),
        kit.clock.now(),
        kit.clock.now() + 600_000,
      ],
    );
    await stageExpiredTestPassRetirement(
      kit.env.DB,
      selected,
      before,
      kit.clock.now(),
      instance.credentialKeysetCommitment,
    );
    expect(await requestState(kit, instance)).toMatchObject({ retirement_requested_at: null });
    expect(
      await first(
        kit.env.DB,
        'SELECT generation FROM wallet_provider_instance_dirty WHERE instance_id = ?',
        [instance.id],
      ),
    ).toBeNull();
  }, 90_000);

  it('holds an accepted Samsung revoke while another provider write is uncertain', async () => {
    const kit = await setupKit({ db: await testDatabase(), template: makeProviderTestTemplate });
    const before = kit.clock.now() - DAY;
    const row = await pass(kit, 'test', before - 1);
    const instance = await native(kit, row, 'test', 'samsung');
    expect(await purgeTestPasses(kit.ctx, before)).toBe(0);
    const busy = kit.fx.ids.id();
    await run(
      kit.env.DB,
      `INSERT INTO wallet_provider_instance_operations
      (id, instance_id, version, kind, request_hash, pass_version, pass_revision, pass_credential_generation,
       lifecycle_generation, issuing_release_id, projection_release_id, account_revision, adapter_revision,
       policy_revision, credential_keyset_commitment, state, attempts, claim_hash, claim_expires_at, created_at)
      SELECT ?, i.id, 2, 'revoke', ?, p.version, p.revision, p.credential_generation, p.lifecycle_generation,
        p.release_id, r.id, a.revision, r.adapter_revision, r.audience_policy_revision,
        ?, 'uncertain', 1, ?, ?, ?
      FROM wallet_provider_instances i JOIN passes p ON p.id = i.pass_id
        JOIN wallet_provider_accounts a ON a.id = i.account_id
        JOIN template_releases r ON r.id = i.identity_projection_release_id
      WHERE i.id = ? AND p.id = ?`,
      [
        busy,
        'b'.repeat(64),
        instance.credentialKeysetCommitment,
        'c'.repeat(64),
        kit.clock.now() + DAY,
        kit.clock.now(),
        instance.id,
        row.id,
      ],
    );
    await acceptRevoke(kit, instance);
    expect(await retireWalletInstance(kit.env.DB, retirement(kit, instance))).toBe(false);
    expect(await purgeTestPasses(kit.ctx, before)).toBe(0);
    expect(await kit.env.BUCKET.head(row.objectKey)).not.toBeNull();
    await run(
      kit.env.DB,
      "UPDATE wallet_provider_instance_operations SET state = 'failed' WHERE id = ?",
      [busy],
    );
    const wrongKeyset = (instance.credentialKeysetCommitment === 'f'.repeat(64) ? 'e' : 'f').repeat(
      64,
    );
    expect(
      await retireWalletInstance(kit.env.DB, {
        ...retirement(kit, instance),
        credentialKeysetCommitment: wrongKeyset,
      }),
    ).toBe(false);
    expect(await retireWalletInstance(kit.env.DB, retirement(kit, instance))).toBe(true);
    expect(await purgeTestPasses(kit.ctx, before)).toBe(1);
    expect(await first(kit.env.DB, 'SELECT id FROM passes WHERE id = ?', [row.id])).toBeNull();
    expect(await kit.env.BUCKET.head(row.objectKey)).toBeNull();
  }, 60_000);

  it('retains an unpromoted Samsung callback tombstone independently of the deleted pass', async () => {
    const { kit, row } = await samsungFixture();
    const before = kit.clock.now() - DAY;
    await editFixedColumns(kit.env.DB, 'passes', 'UPDATE passes SET created_at = ? WHERE id = ?', [
      before - 1,
      row.id,
    ]);
    const reference = await first<{ ref_hash: string; promoted_at: number | null }>(
      kit.env.DB,
      `SELECT r.ref_hash, r.promoted_at FROM wallet_samsung_fetch_refs r
       JOIN wallet_provider_instances i ON i.id = r.instance_id WHERE i.pass_id = ?`,
      [row.id],
    );
    if (!reference) throw new Error('Missing Samsung reference');
    expect(reference.promoted_at).toBeNull();
    expect(await purgeTestPasses(kit.ctx, before)).toBe(0);
    await drainWalletProviderSync(kit.ctx);
    const instance = await first<{
      id: string;
      account_id: string;
      desired_version: number;
      desired_operation_id: string;
      kind: string;
      credential_keyset_commitment: string | null;
    }>(
      kit.env.DB,
      `SELECT i.id, i.account_id, i.desired_version, i.desired_operation_id, op.kind, op.credential_keyset_commitment
     FROM wallet_provider_instances i JOIN wallet_provider_instance_operations op ON op.id = i.desired_operation_id
     WHERE i.pass_id = ?`,
      [row.id],
    );
    if (!instance?.credential_keyset_commitment)
      throw new Error('Missing Samsung retirement keyset');
    expect(instance.kind).toBe('revoke');
    // Model the provider's accepted revoke; retirement must still persist the callback verifier.
    await run(
      kit.env.DB,
      "UPDATE wallet_provider_instance_operations SET state = 'succeeded', next_attempt_at = NULL WHERE id = ?",
      [instance.desired_operation_id],
    );
    await run(
      kit.env.DB,
      "UPDATE wallet_provider_instances SET lifecycle = 'revoking' WHERE id = ?",
      [instance.id],
    );
    await run(
      kit.env.DB,
      "UPDATE wallet_provider_instances SET lifecycle = 'revoked' WHERE id = ?",
      [instance.id],
    );
    const ref = {
      instanceId: instance.id,
      orgId: kit.org.id,
      mode: 'test' as const,
      provider: 'samsung' as const,
      version: instance.desired_version,
      credentialKeysetCommitment: instance.credential_keyset_commitment,
    };
    expect(await retireWalletInstance(kit.env.DB, { ...ref, now: kit.clock.now() })).toBe(false);
    expect(await purgeTestPasses(kit.ctx, before)).toBe(0);
    expect(await kit.env.BUCKET.head(row.objectKey)).not.toBeNull();
    expect(await finishWalletProviderRetirement(kit.ctx, ref)).toBe(true);
    expect(await purgeTestPasses(kit.ctx, before)).toBe(1);
    const tombstone = await first<Record<string, unknown>>(
      kit.env.DB,
      'SELECT * FROM wallet_samsung_tombstones WHERE ref_hash = ?',
      [reference.ref_hash],
    );
    expect(tombstone).toMatchObject({
      ref_hash: reference.ref_hash,
      org_id: kit.org.id,
      mode: 'test',
      account_id: instance.account_id,
      credential_keyset_commitment: instance.credential_keyset_commitment,
    });
    expect(JSON.stringify(tombstone)).not.toContain(row.id);
    expect(JSON.stringify(tombstone)).not.toContain(instance.id);
    expect(JSON.stringify(tombstone)).not.toContain('private@example.test');
    expect(
      await first(kit.env.DB, 'SELECT id FROM wallet_provider_instances WHERE id = ?', [
        instance.id,
      ]),
    ).toBeNull();
    expect(await kit.env.BUCKET.head(row.objectKey)).toBeNull();
  }, 90_000);

  it('does not purge or close blocked placeholders during a pending credential transfer', async () => {
    const { kit, row, instance } = await samsungFixture();
    const before = kit.clock.now() - DAY;
    await editFixedColumns(kit.env.DB, 'passes', 'UPDATE passes SET created_at = ? WHERE id = ?', [
      before - 1,
      row.id,
    ]);
    const selected = (await expiredTestPasses(kit.env.DB, before, 100)).find(
      (item) => item.id === row.id,
    );
    const expected = await getHolderPass(kit.env.DB, row.id, null);
    if (!selected || !expected) throw new Error('Missing pre-transfer snapshot');
    const result = await startCredentialTransfer(
      jobCtxOf(kit),
      { type: 'system', id: null },
      row.id,
      { holderEmail: 'next@example.test', ownerUserId: null },
      null,
      { kind: 'tenant-holder', expected },
    );
    expect(result.state).toBe('pending');
    await stageExpiredTestPassRetirement(
      kit.env.DB,
      selected,
      before,
      kit.clock.now(),
      instance.credentialKeysetCommitment,
    );
    expect(
      (await expiredTestPasses(kit.env.DB, before, 100)).some((item) => item.id === row.id),
    ).toBe(false);
    expect(await purgeTestPasses(kit.ctx, before)).toBe(0);
    expect(
      await first(
        kit.env.DB,
        `SELECT COUNT(*) AS n FROM wallet_provider_instances
      WHERE pass_id = ? AND credential_generation = ? AND lifecycle = 'blocked' AND retirement_requested_at IS NULL`,
        [row.id, selected.credentialGeneration + 1],
      ),
    ).toEqual({ n: 2 });
    expect(
      await first(
        kit.env.DB,
        `SELECT i.lifecycle, i.retirement_requested_at FROM wallet_provider_instances i
      JOIN wallet_samsung_fetch_refs r ON r.instance_id = i.id
      WHERE i.pass_id = ? AND i.credential_generation = ? AND i.provider = 'samsung'`,
        [row.id, selected.credentialGeneration],
      ),
    ).toMatchObject({
      lifecycle: 'active',
      retirement_requested_at: kit.clock.now(),
    });
    expect(await first(kit.env.DB, 'SELECT id FROM passes WHERE id = ?', [row.id])).not.toBeNull();
    expect(await kit.env.BUCKET.head(row.objectKey)).not.toBeNull();
  }, 120_000);

  it('clears scanner deletion intent when transfer starts after sandbox selection', async () => {
    const kit = await withKitDatabase(await testDatabase(), setupScanKit);
    const templateId = await kit.scanTemplate(
      'Transfer race',
      {
        actions: [{ id: 'entry', label: 'Enter', kind: 'check_in' }],
      },
      {
        releaseModes: ['test'],
        passStyle: {
          barcodes: [{ format: 'PKBarcodeFormatQR', message: 'x', messageEncoding: 'utf-8' }],
        },
      },
    );
    const event = await kit.event({ mode: 'test', templateIds: [templateId] });
    const scanner = await kit.scanner({
      mode: 'test',
      eventId: event.id,
      templateIds: [templateId],
    });
    const pass = await kit.scanPass(
      templateId,
      { memberName: 'Private Holder' },
      {
        mode: 'test',
        holderEmail: 'private@example.test',
      },
    );
    const scan = await kit.post(scanner.headers, '/actions', {
      idempotencyKey: key(),
      input: codeOf(pass),
      clientTs: kit.clock.now(),
      actionId: 'entry',
    });
    expect(scan.status).toBe(200);
    const outcome = (await scan.json()) as { kind: string; scanId: string };
    expect(outcome.kind).toBe('ok');
    const proof = await first<{ pass_ref: string }>(
      kit.env.DB,
      'SELECT pass_ref FROM scan_retention_proofs WHERE scan_id = ?',
      [outcome.scanId],
    );
    if (!proof) throw new Error('Missing scan retention proof');
    const before = kit.clock.now() - DAY;
    await editFixedColumns(kit.env.DB, 'passes', 'UPDATE passes SET created_at = ? WHERE id = ?', [
      before - 1,
      pass.id,
    ]);
    await samsungProjection(kit, pass);
    const expected = await getHolderPass(kit.env.DB, pass.id, null);
    if (!expected) throw new Error('Missing holder snapshot');
    let transferId: string | undefined;
    const race = raceFirstBatch(kit.ctx, async () => {
      await native(kit, pass, 'test', 'samsung');
      const transfer = await startCredentialTransfer(
        jobCtxOf(kit),
        { type: 'system', id: null },
        pass.id,
        { holderEmail: 'next@example.test', ownerUserId: null },
        null,
        { kind: 'tenant-holder', expected },
      );
      expect(transfer.state).toBe('pending');
      transferId = transfer.transferId;
    });
    expect(await purgeTestPasses(race.ctx, before)).toBe(0);
    expect(race.invoked()).toBe(true);
    expect(transferId).toBeTruthy();
    expect(
      await first(kit.env.DB, 'SELECT state FROM pass_credential_transfers WHERE id = ?', [
        transferId!,
      ]),
    ).toEqual({ state: 'pending' });
    expect(
      await first(kit.env.DB, 'SELECT pass_id FROM scans WHERE id = ?', [outcome.scanId]),
    ).toEqual({ pass_id: pass.id });
    expect(
      await first(kit.env.DB, 'SELECT 1 FROM scan_retained_gates WHERE scan_id = ?', [
        outcome.scanId,
      ]),
    ).toBeNull();
    expect(
      await first(
        kit.env.DB,
        'SELECT 1 FROM scan_retention_delete_intents WHERE scan_id = ? OR pass_ref = ?',
        [outcome.scanId, proof.pass_ref],
      ),
    ).toBeNull();
    expect(await kit.env.BUCKET.head(pass.objectKey)).not.toBeNull();
  }, 120_000);

  it('waits for provider retirement and preserves opaque scan provenance for the same expired pass', async () => {
    const kit = await withKitDatabase(await testDatabase(), setupScanKit);
    const templateId = await kit.scanTemplate(
      'Retention event',
      {
        actions: [{ id: 'privategate', label: 'Enter', kind: 'check_in' }],
      },
      {
        releaseModes: ['test'],
        passStyle: {
          barcodes: [{ format: 'PKBarcodeFormatQR', message: 'x', messageEncoding: 'utf-8' }],
        },
      },
    );
    const event = await kit.event({ mode: 'test', templateIds: [templateId] });
    const scanner = await kit.scanner({
      mode: 'test',
      eventId: event.id,
      templateIds: [templateId],
    });
    const pass = await kit.scanPass(
      templateId,
      { memberName: 'Private Holder' },
      {
        mode: 'test',
        holderEmail: 'private@example.test',
      },
    );
    const response = await kit.post(scanner.headers, '/actions', {
      idempotencyKey: key(),
      input: codeOf(pass),
      clientTs: kit.clock.now(),
      actionId: 'privategate',
    });
    expect(response.status).toBe(200);
    const outcome = (await response.json()) as { kind: string; scanId: string };
    expect(outcome.kind).toBe('ok');
    expect(outcome.scanId).toBeTruthy();
    const proof = await first<{ pass_ref: string; excluded: number; invalidated: number }>(
      kit.env.DB,
      'SELECT pass_ref, excluded, invalidated FROM scan_retention_proofs WHERE scan_id = ?',
      [outcome.scanId],
    );
    expect(proof).toMatchObject({ excluded: 0, invalidated: 0 });
    if (!proof) throw new Error('Expected signed scan provenance');
    const before = kit.clock.now() - DAY;
    await editFixedColumns(kit.env.DB, 'passes', 'UPDATE passes SET created_at = ? WHERE id = ?', [
      before - 1,
      pass.id,
    ]);
    await samsungProjection(kit, pass);
    let lateInstance: Native | undefined;
    const race = raceFirstBatch(kit.ctx, async () => {
      lateInstance = await native(kit, pass, 'test', 'samsung');
    });
    expect(await purgeTestPasses(race.ctx, before)).toBe(0);
    expect(race.invoked()).toBe(true);
    if (!lateInstance) throw new Error('Expected provider instance at the delete boundary');
    expect(
      await first(kit.env.DB, 'SELECT 1 FROM scan_retained_gates WHERE scan_id = ?', [
        outcome.scanId,
      ]),
    ).toBeNull();
    expect(
      await first(
        kit.env.DB,
        'SELECT 1 FROM scan_retention_delete_intents WHERE scan_id = ? OR pass_ref = ?',
        [outcome.scanId, proof.pass_ref],
      ),
    ).toBeNull();
    expect(await purgeTestPasses(kit.ctx, before)).toBe(0);
    expect(
      await first(kit.env.DB, 'SELECT pass_id FROM scans WHERE id = ?', [outcome.scanId]),
    ).toEqual({ pass_id: pass.id });
    expect(await kit.env.BUCKET.head(pass.objectKey)).not.toBeNull();
    await acceptRevoke(kit, lateInstance);
    expect(await retireWalletInstance(kit.env.DB, retirement(kit, lateInstance))).toBe(true);
    expect(await purgeTestPasses(kit.ctx, before)).toBe(1);
    expect(await first(kit.env.DB, 'SELECT id FROM passes WHERE id = ?', [pass.id])).toBeNull();
    expect(await kit.env.BUCKET.head(pass.objectKey)).toBeNull();
    expect(
      await first(kit.env.DB, 'SELECT pass_id FROM scans WHERE id = ?', [outcome.scanId]),
    ).toEqual({ pass_id: null });
    const retainedProof = await first<Record<string, unknown>>(
      kit.env.DB,
      'SELECT * FROM scan_retention_proofs WHERE scan_id = ?',
      [outcome.scanId],
    );
    const gate = await first<Record<string, unknown>>(
      kit.env.DB,
      'SELECT * FROM scan_retained_gates WHERE scan_id = ?',
      [outcome.scanId],
    );
    expect(retainedProof).toMatchObject({ pass_ref: proof.pass_ref, excluded: 0, invalidated: 0 });
    expect(gate).toMatchObject({
      scan_id: outcome.scanId,
      org_id: kit.org.id,
      mode: 'test',
      event_id: event.id,
      pass_ref: proof.pass_ref,
    });
    const retained = JSON.stringify({ retainedProof, gate });
    for (const secret of [
      pass.id,
      pass.downloadToken,
      pass.scanCode,
      'Private Holder',
      'private@example.test',
      'privategate',
    ]) {
      if (secret) expect(retained).not.toContain(secret);
    }
  }, 90_000);

  it('closes an unissued Google placeholder without inventing provider evidence', async () => {
    const kit = await setupKit({ db: await testDatabase(), template: makeProviderTestTemplate });
    const before = kit.clock.now() - DAY;
    const row = await pass(kit, 'test', before - 1);
    const expected = await getHolderPass(kit.env.DB, row.id, null);
    if (!expected) throw new Error('Missing pass');
    expect(
      await startCredentialTransfer(
        jobCtxOf(kit),
        { type: 'system', id: null },
        row.id,
        { holderEmail: 'next@example.test', ownerUserId: null },
        null,
        { kind: 'tenant-holder', expected },
      ),
    ).toMatchObject({ state: 'completed' });
    const placeholder = await first<{ id: string }>(
      kit.env.DB,
      `SELECT id FROM wallet_provider_instances
      WHERE pass_id = ? AND provider = 'google' AND lifecycle = 'ready'`,
      [row.id],
    );
    if (!placeholder) throw new Error('Missing unissued Google placeholder');
    expect(await purgeTestPasses(kit.ctx, before)).toBe(0);
    expect(
      await first(
        kit.env.DB,
        `SELECT lifecycle, retirement_reason, account_id, desired_operation_id
      FROM wallet_provider_instances WHERE id = ?`,
        [placeholder.id],
      ),
    ).toEqual({
      lifecycle: 'retired',
      retirement_reason: 'not_issued',
      account_id: null,
      desired_operation_id: null,
    });
    expect(
      await first(kit.env.DB, 'SELECT 1 FROM wallet_provider_offer_refs WHERE instance_id = ?', [
        placeholder.id,
      ]),
    ).toBeNull();
    expect(await purgeTestPasses(kit.ctx, before)).toBe(1);
    expect(await first(kit.env.DB, 'SELECT id FROM passes WHERE id = ?', [row.id])).toBeNull();
  }, 90_000);

  it('advances past held candidates across bounded daily runs', async () => {
    const kit = await setupKit({ db: await testDatabase(), template: makeProviderTestTemplate });
    const before = kit.clock.now() - DAY;
    const instances: Native[] = [];
    for (let index = 0; index < 76; index++) {
      const row = await pass(kit, 'test', before - 100 + index);
      instances.push(await native(kit, row, 'test', 'samsung'));
    }
    expect(await purgeTestPasses(kit.ctx, before)).toBe(0);
    const count = () =>
      first<{ n: number }>(
        kit.env.DB,
        'SELECT COUNT(*) AS n FROM wallet_provider_instances WHERE retirement_requested_at IS NOT NULL',
      );
    expect((await count())?.n).toBe(75);
    expect(await requestState(kit, instances[75]!)).toMatchObject({
      retirement_requested_at: null,
    });
    expect(await purgeTestPasses(kit.ctx, before)).toBe(0);
    expect((await count())?.n).toBe(76);
    expect(await requestState(kit, instances[75]!)).toMatchObject({
      retirement_requested_at: kit.clock.now(),
    });
  }, 180_000);
});
