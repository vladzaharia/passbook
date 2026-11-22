import { z } from 'zod';
import { IdSchema, ModeSchema, TimestampSchema } from '../../../shared/contracts/common.ts';
import type { SessionAuth } from '../../platform/auth.ts';
import {
  ConflictError,
  ForbiddenError,
  NotFoundError,
  ValidationError,
} from '../../platform/errors.ts';
import type { ServiceContext } from '../../platform/service-context.ts';
import { requireCredentialRefKeyset } from '../passes/credential-keyset.ts';
import { type TenantPassWrite, tenantAuthorityOf } from '../passes/http.ts';
import { candidateHash } from '../templates/release-content.ts';
import {
  readConfiguredWalletProviderCredentials,
  snapshotWalletCredentialContext,
} from './account-service.ts';
import {
  identityCardType,
  type ProjectionV2,
  providerIdentityHash,
} from './projection-contract.ts';
import { assertWalletProviderEnabled, walletProviderEnabled } from './provider-policy.ts';
import {
  getProjectionCandidate,
  type ProjectionCandidate,
  projectionCandidateEnvelope,
} from './repo-projection-store.ts';
import {
  clearSamsungCardState,
  putSamsungCardState,
  samsungCardStateFresh,
} from './repo-samsung-card-state.ts';
import {
  beginSamsungProjectionProbe,
  completeSamsungProjectionProbe,
  failSamsungProjectionProbe,
  hasSamsungProjectionEvidence,
} from './repo-samsung-verification.ts';
import { validateSamsungCredentials } from './samsung-credentials.ts';
import { probeSamsungActiveTemplate } from './samsung-template.ts';

const MAX_EVIDENCE_AGE_MS = 300_000;
type Authority = Extract<TenantPassWrite, { kind: 'session' }>;

/** A card template's reported state is not proof of recipient-market eligibility. */
export const SamsungVerificationInputSchema = z.strictObject({
  orgId: IdSchema,
  mode: ModeSchema,
  candidateId: IdSchema,
  candidateHash: z.string().regex(/^[0-9a-f]{64}$/),
});
export type SamsungVerificationInput = z.infer<typeof SamsungVerificationInputSchema>;
export const SamsungVerificationResultSchema = z.strictObject({
  verified: z.boolean(),
  verifiedAt: TimestampSchema.nullable(),
  expiresAt: TimestampSchema.nullable(),
});
export type SamsungVerificationResult = z.infer<typeof SamsungVerificationResultSchema>;
const unverified = (): SamsungVerificationResult => ({
  verified: false,
  verifiedAt: null,
  expiresAt: null,
});

async function candidateForProbe(
  ctx: ServiceContext,
  candidateId: string,
  expectedHash: string,
): Promise<ProjectionCandidate | null> {
  if (!IdSchema.safeParse(candidateId).success || !/^[0-9a-f]{64}$/.test(expectedHash)) return null;
  const candidate = await getProjectionCandidate(ctx.env.DB, candidateId);
  if (
    candidate?.provider !== 'samsung' ||
    candidate.projection.provider !== 'samsung' ||
    candidate.candidateHash !== expectedHash ||
    (await candidateHash(projectionCandidateEnvelope(candidate))) !== expectedHash
  )
    return null;
  return candidate;
}

/** Only verified responses are retained; credentials, tokens, and response bodies are never logged. */
async function probe(
  ctx: ServiceContext,
  candidate: ProjectionCandidate,
  authority: Authority | null,
): Promise<SamsungVerificationResult> {
  if (
    candidate.projection.provider !== 'samsung' ||
    candidate.projection.schema !== 1 ||
    !walletProviderEnabled('samsung', candidate.mode)
  )
    return unverified();
  const probeId = ctx.ids.id();
  if (!(await beginSamsungProjectionProbe(ctx, authority, candidate, probeId))) return unverified();
  try {
    const scope = { orgId: candidate.orgId, mode: candidate.mode, provider: 'samsung' as const };
    const account = await readConfiguredWalletProviderCredentials(ctx, scope, {
      accountId: candidate.accountId,
      authorityEpoch: candidate.accountEpoch,
    });
    if (
      account?.provider !== 'samsung' ||
      account.accountId !== candidate.accountId ||
      account.authorityEpoch !== candidate.accountEpoch ||
      (await providerIdentityHash(account, identityCardType(candidate.projection))) !==
        candidate.providerIdentityHash
    )
      throw new Error();
    const startedAt = ctx.clock.now();
    const credentials = await validateSamsungCredentials(
      account.credentials,
      startedAt,
      candidate.projection.cardType,
    );
    const response = await probeSamsungActiveTemplate(credentials, {
      cardType: candidate.projection.cardType,
      subType: candidate.projection.cardSubType,
      countryCode: candidate.projection.countryCode,
      mode: candidate.mode,
      now: startedAt,
      requestId: ctx.ids.id().replaceAll('-', ''),
    });
    if (
      response.state !== 'ACTIVE' ||
      response.testingModeOff !== 'Y' ||
      response.cardId !== credentials.cardId ||
      response.verifiedAt !== startedAt
    )
      throw new Error();
    const expiresAt = Math.min(startedAt + MAX_EVIDENCE_AGE_MS, credentials.validUntil);
    if (
      (await completeSamsungProjectionProbe(
        ctx,
        authority,
        candidate,
        probeId,
        startedAt,
        expiresAt,
      )) &&
      (await hasSamsungProjectionEvidence(ctx, candidate))
    )
      return { verified: true, verifiedAt: startedAt, expiresAt };
  } catch {
    // Never log upstream errors, credentials, identifiers, tokens, or response bodies.
    ctx.log.warn('wallet.verification_failed', { code: 'WALLET_VERIFY_FAILED' });
  }
  await failSamsungProjectionProbe(ctx, authority, candidate, probeId);
  return unverified();
}

/** Authenticated administrative recheck of an independently reviewed immutable projection. */
export async function refreshSamsungProjectionEvidence(
  ctx: ServiceContext,
  auth: SessionAuth,
  input: SamsungVerificationInput,
): Promise<SamsungVerificationResult> {
  ctx = snapshotWalletCredentialContext(ctx);
  const parsed = SamsungVerificationInputSchema.safeParse(input);
  if (!parsed.success) throw new ValidationError();
  if (auth?.kind !== 'session' || auth.mode !== parsed.data.mode) throw new ForbiddenError();
  const authority = await tenantAuthorityOf(ctx, auth, parsed.data.orgId, 'integrations:manage');
  if (authority.kind !== 'session') throw new ForbiddenError();
  assertWalletProviderEnabled('samsung', parsed.data.mode);
  await requireCredentialRefKeyset(ctx.env.DB, ctx.env);
  const candidate = await candidateForProbe(
    ctx,
    parsed.data.candidateId,
    parsed.data.candidateHash,
  );
  if (!candidate || candidate.orgId !== parsed.data.orgId || candidate.mode !== parsed.data.mode)
    throw new NotFoundError(
      'Wallet projection candidate not found.',
      'WALLET_PROJECTION_NOT_FOUND',
    );
  if (candidate.projection.schema === 2) {
    const read = await refreshSamsungCardState(ctx, candidate);
    return read ? { verified: true, ...read } : unverified();
  }
  const result = await probe(ctx, candidate, authority);
  if (!result.verified && !(await hasSamsungProjectionEvidence(ctx, candidate))) return result;
  if (!result.verified)
    throw new ConflictError('A newer verification is in progress.', 'WALLET_VERIFICATION_CONFLICT');
  return result;
}

/** The sync job's refresh: probes again although the cached proof still holds, so it does not lapse under readers. */
export async function reprobeSamsungProjectionEvidence(
  ctx: ServiceContext,
  candidateId: string,
  expectedHash: string,
): Promise<boolean> {
  ctx = snapshotWalletCredentialContext(ctx);
  await requireCredentialRefKeyset(ctx.env.DB, ctx.env);
  const candidate = await candidateForProbe(ctx, candidateId, expectedHash);
  return candidate ? (await probe(ctx, candidate, null)).verified : false;
}

/**
 * Trusted issuance/publish callers may refresh an expired proof without an administrative session.
 * The candidate and separate human review are checked again at the database write. This establishes
 * card-state evidence only, not permission to issue or eligibility in a recipient's market.
 */
export async function ensureSamsungProjectionEvidence(
  ctx: ServiceContext,
  candidateId: string,
  expectedHash: string,
  authority: Authority | null = null,
): Promise<boolean> {
  ctx = snapshotWalletCredentialContext(ctx);
  await requireCredentialRefKeyset(ctx.env.DB, ctx.env);
  const candidate = await candidateForProbe(ctx, candidateId, expectedHash);
  if (!candidate) return false;
  if (candidate.projection.schema === 2) return ensureSamsungCardState(ctx, candidate);
  if (await hasSamsungProjectionEvidence(ctx, candidate)) return true;
  return (await probe(ctx, candidate, authority)).verified;
}

type CompiledCandidate = ProjectionCandidate & { projection: ProjectionV2 };
const isCompiled = (c: ProjectionCandidate): c is CompiledCandidate =>
  c.provider === 'samsung' && c.projection.schema === 2;

/**
 * Reads the card of a compiled (schema 2) candidate from Samsung now, mode-aware (Live needs a
 * launched card, Test also takes one still in testing mode), and records it in the candidate's
 * card-state row. A failed read removes the row. Returns the read, or null when the card is not
 * usable. Only publish, an update, the admin recheck and the sync job call this: request paths
 * read the row.
 */
export async function refreshSamsungCardState(
  ctx: ServiceContext,
  candidate: ProjectionCandidate,
): Promise<{ verifiedAt: number; expiresAt: number } | null> {
  if (!isCompiled(candidate) || !walletProviderEnabled('samsung', candidate.mode)) return null;
  const projection = candidate.projection;
  const now = ctx.clock.now();
  ctx = snapshotWalletCredentialContext(ctx);
  try {
    await requireCredentialRefKeyset(ctx.env.DB, ctx.env);
    const scope = { orgId: candidate.orgId, mode: candidate.mode, provider: 'samsung' as const };
    const account = await readConfiguredWalletProviderCredentials(ctx, scope, {
      accountId: candidate.accountId,
      authorityEpoch: candidate.accountEpoch,
    });
    if (
      account?.provider !== 'samsung' ||
      account.accountId !== candidate.accountId ||
      account.authorityEpoch !== candidate.accountEpoch ||
      (await providerIdentityHash(account, identityCardType(projection))) !==
        candidate.providerIdentityHash
    )
      throw new Error();
    const credentials = await validateSamsungCredentials(account.credentials, now, projection.type);
    const read = await probeSamsungActiveTemplate(credentials, {
      cardType: projection.type,
      mode: candidate.mode,
      now,
      requestId: ctx.ids.id().replaceAll('-', ''),
    });
    const expiresAt = Math.min(now + MAX_EVIDENCE_AGE_MS, credentials.validUntil);
    if (
      expiresAt > now &&
      (await putSamsungCardState(ctx.env.DB, {
        candidateId: candidate.id,
        candidateHash: candidate.candidateHash,
        accountId: candidate.accountId,
        accountEpoch: candidate.accountEpoch,
        cardType: projection.type,
        state: read.state,
        testingModeOff: read.testingModeOff,
        verifiedAt: now,
        expiresAt,
      }))
    )
      return { verifiedAt: now, expiresAt };
  } catch {
    // Never log upstream errors, credentials, identifiers, tokens, or response bodies.
    ctx.log.warn('wallet.verification_failed', { code: 'WALLET_VERIFY_FAILED' });
  }
  await clearSamsungCardState(ctx.env.DB, candidate.id);
  return null;
}

/** The stored read, if it is still within its five minutes. Never calls Samsung. */
export function samsungCardFresh(
  ctx: ServiceContext,
  candidate: ProjectionCandidate,
): Promise<boolean> {
  if (!isCompiled(candidate) || !walletProviderEnabled('samsung', candidate.mode))
    return Promise.resolve(false);
  return samsungCardStateFresh(ctx.env.DB, candidate, candidate.projection.type, ctx.clock.now());
}

/** A fresh row, else a live read: the decision of a publish or an update. */
export async function ensureSamsungCardState(
  ctx: ServiceContext,
  candidate: ProjectionCandidate,
): Promise<boolean> {
  return (
    (await samsungCardFresh(ctx, candidate)) ||
    (await refreshSamsungCardState(ctx, candidate)) !== null
  );
}

/** The sync job's pass over compiled cards whose row is missing or about to lapse. */
export async function refreshSamsungCardStates(
  ctx: ServiceContext,
  candidates: { id: string; hash: string }[],
): Promise<number> {
  let refreshed = 0;
  for (const item of candidates) {
    const candidate = await getProjectionCandidate(ctx.env.DB, item.id);
    if (candidate?.candidateHash === item.hash && (await refreshSamsungCardState(ctx, candidate)))
      refreshed++;
  }
  return refreshed;
}
