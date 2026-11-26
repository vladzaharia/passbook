import { CompactSign, importPKCS8 } from 'jose';
import { createApp } from '../../app.ts';
import { credentialAad, encryptSecret, loadKekRing } from '../../platform/crypto.ts';
import { sha256Hex } from '../../platform/ids.ts';
import { ensureCredentialRefKeyset } from '../passes/credential-keyset.ts';
import { readWalletPassSnapshot } from './instance.ts';
import { type OfferFixtureSource, setupWalletOfferKit } from './offers-test-fixtures.ts';
import { getApprovedProjection } from './projection-service.ts';
import { setWalletProvidersEnabledForTest } from './provider-policy.ts';
import { releaseRows } from './release-test-fixtures.ts';
import {
  findCallbackCredentialKeyset,
  findCallbackCredentialKeysetTrigger,
  replaceCallbackCredentialKeysetBatch,
} from './repo-callbacks-test-fixtures.ts';
import {
  seedHistoricalOfferRef,
  seedHistoricalProviderInstance,
  seedHistoricalSamsungRef,
} from './runtime-historical-fixtures.ts';

const origin = 'https://wallet.test';

/** Seed a historical ref in tests only; no new provider offer or market proof is fabricated. */
export async function setupSamsungCallbacks(
  options: {
    promoted?: boolean;
    reference?: boolean;
    holderEmail?: string;
    source?: OfferFixtureSource;
    db?: D1Database;
    /** The account is a real enrolment, not a legacy envelope. */
    enrolled?: boolean;
    /** Every database guard stays: the release rows are opened and the instance and reference insert through them. */
    guards?: boolean;
  } = {},
) {
  // Historical Samsung instances are only retired or refreshed while the provider is enabled.
  setWalletProvidersEnabledForTest(true);
  const fixture = await setupWalletOfferKit({
    google: 'absent',
    samsung: 'published',
    holderEmail: options.holderEmail,
    source: options.source,
    db: options.db,
    ...(options.enrolled ? { enrolled: true } : {}),
  });
  const { kit, pass, samsung, samsungRelease } = fixture;
  if (!samsungRelease?.candidateId || !pass.releaseId) throw new Error('Missing release fixture');
  const credentialKeysetCommitment = await ensureCredentialRefKeyset(kit.env.DB, kit.env);
  if (options.guards) await releaseRows(kit.env.DB);
  const mode = 'live' as const;
  const source = await readWalletPassSnapshot(kit.env.DB, {
    orgId: kit.org.id,
    mode,
    passId: pass.id,
  });
  const approved = await getApprovedProjection(kit.ctx, {
    orgId: kit.org.id,
    mode,
    provider: 'samsung',
    templateId: pass.templateId,
    templateVersion: pass.templateVersion,
    appleReleaseId: pass.releaseId,
  });
  if (!source || !approved) throw new Error('Missing approved source fixture');
  const operation = await seedHistoricalProviderInstance(kit.env.DB, {
    id: kit.ctx.ids.id(),
    operationId: kit.ctx.ids.id(),
    credentialKeysetCommitment,
    passId: pass.id,
    orgId: kit.org.id,
    mode,
    provider: 'samsung',
    credentialGeneration: source.credentialGeneration,
    accountId: approved.release.accountId,
    releaseId: approved.release.id,
    now: kit.clock.now(),
    ...(options.guards ? { keepGuard: true } : {}),
    upsert: { requestHash: await sha256Hex(kit.ctx.ids.token(32)), state: 'pending' },
  });
  if (!operation) throw new Error('Missing historical instance fixture');
  const refId = kit.ctx.ids.token(24);
  const referenceId = kit.ctx.ids.id();
  const now = kit.clock.now();
  const envelope = await encryptSecret(
    await loadKekRing(kit.env),
    refId,
    credentialAad(referenceId, kit.org.id, `samsung-ref|${mode}|${operation.instanceId}`),
  );
  if (options.reference !== false) {
    await seedHistoricalSamsungRef(kit.env.DB, {
      id: referenceId,
      refHash: await sha256Hex(refId),
      instanceId: operation.instanceId,
      credentialKeysetCommitment,
      createdAt: now,
      initialExpiresAt: now + 300_000,
      promotedAt: options.promoted === false ? null : now,
      envelope,
      ...(options.guards ? { keepGuard: true } : {}),
    });
  }
  if (options.reference !== false && options.promoted === false) {
    await seedHistoricalOfferRef(kit.env.DB, {
      refHash: await sha256Hex(kit.ctx.ids.token(32)),
      instanceId: operation.instanceId,
      operationVersion: operation.version,
      createdAt: now,
      expiresAt: now + 300_000,
      consumedAt: now,
      deliveredAt: now,
    });
  }
  const key = (await importPKCS8(samsung.partnerPrivateKeyPem, 'RS256')) as CryptoKey;
  const app = createApp({ clock: kit.clock });
  const path = `/wallet/v1/samsung/cards/${samsung.cardId}/${refId}`;

  async function token(
    input: {
      method?: 'GET' | 'POST';
      signedPath?: string;
      utc?: number;
      partnerId?: string;
      certificateId?: string;
      signingKey?: CryptoKey;
      tokenRefId?: string;
    } = {},
  ): Promise<string> {
    if (input.utc === undefined) kit.clock.advance(1);
    return new CompactSign(
      new TextEncoder().encode(
        JSON.stringify({
          API: { method: input.method ?? 'GET', path: input.signedPath ?? path },
          refId: input.tokenRefId ?? refId,
        }),
      ),
    )
      .setProtectedHeader({
        alg: 'RS256',
        cty: 'AUTH',
        ver: '3',
        utc: input.utc ?? kit.clock.now(),
        partnerId: input.partnerId ?? samsung.partnerId,
        certificateId: input.certificateId ?? samsung.certificateId,
      })
      .sign(input.signingKey ?? key);
  }
  function call(
    input: {
      token?: string;
      method?: 'GET' | 'POST';
      path?: string;
      query?: string;
      body?: string;
      requestId?: string;
    } = {},
  ) {
    return app.request(
      `${origin}${input.path ?? path}${input.query ?? ''}`,
      {
        method: input.method ?? 'GET',
        headers: {
          'x-request-id': input.requestId ?? 'fixture-request',
          ...(input.token ? { authorization: `Bearer ${input.token}` } : {}),
        },
        ...(input.body === undefined ? {} : { body: input.body }),
      },
      kit.env,
    );
  }
  return {
    ...fixture,
    key,
    refId,
    referenceId,
    operation,
    path,
    token,
    call,
    credentialKeysetCommitment,
  };
}

/** Test-only simulation of a separately audited keyset change or a missing singleton. */
export async function replaceCallbackKeysetForTest(
  db: D1Database,
  commitment: string | null,
): Promise<void> {
  const existing = await findCallbackCredentialKeyset(db);
  const triggerName =
    commitment === null
      ? 'credential_ref_keyset_no_delete'
      : existing
        ? 'credential_ref_keyset_no_update'
        : 'credential_ref_keyset_insert_guard';
  const trigger = await findCallbackCredentialKeysetTrigger(db, triggerName);
  if (!trigger?.sql) throw new Error('Missing credential keyset guard');
  await replaceCallbackCredentialKeysetBatch(db, triggerName, commitment, !!existing, trigger);
}
