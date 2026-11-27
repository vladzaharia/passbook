import {
  type RevokeWalletCredential,
  type SaveWalletCredential,
  SaveWalletCredentialSchema,
  type WalletCredential,
  type WalletCredentialList,
} from '../../../shared/contracts/wallet-providers.ts';
import type { PlatformWalletCredentialList } from '../../../shared/contracts/wallet-release.ts';
import type { SessionAuth } from '../../platform/auth.ts';
import { credentialAad, encryptSecret, loadKekRing } from '../../platform/crypto.ts';
import {
  ConflictError,
  ForbiddenError,
  NotFoundError,
  ValidationError,
} from '../../platform/errors.ts';
import type { ServiceContext } from '../../platform/service-context.ts';
import { tenantAuthorityOf } from '../passes/http.ts';
import { capabilityChecks, tenantPrincipal } from '../passes/repo-authority.ts';
import { enqueueVersionCheck } from './account-check.ts';
import { snapshotWalletCredentialContext } from './account-credential-material.ts';
import { credentialIdentityHash } from './account-credential-source.ts';
import { validateGoogleAccount } from './google-credentials.ts';
import { isActor, type PlatformCaller } from './platform-caller.ts';
import { walletReleaseByMode } from './provider-policy.ts';
import { lastChecksOf } from './repo-credential-checks.ts';
import {
  type CredentialRow,
  type CredentialWriter,
  cardMapOf,
  findActiveCredential,
  findCredential,
  listCredentials,
  revokeCredential,
  saveCredential,
} from './repo-credentials.ts';
import { DEFAULT_CARD_TYPE, samsungCardMap } from './samsung-cards.ts';
import { validateSamsungCredentials } from './samsung-credentials.ts';

/** The types that have a card: the default card serves loyalty, every other type has its own entry. */
function cardTypesOf(row: CredentialRow): string[] {
  if (row.provider !== 'samsung' || !row.card_map) return [];
  try {
    const keys = Object.keys(JSON.parse(row.card_map) as Record<string, string>);
    return [...new Set(keys.map((key) => (key === DEFAULT_CARD_TYPE ? 'loyalty' : key)))].sort();
  } catch {
    return [];
  }
}

export function credentialDto(
  row: CredentialRow,
  lastCheck: WalletCredential['lastCheck'] = null,
): WalletCredential {
  return {
    id: row.id,
    scope: row.scope,
    orgId: row.org_id,
    mode: row.mode,
    provider: row.provider,
    identityHint: row.identity_hint,
    provenance: row.provenance,
    revision: row.revision,
    verifiedAt: row.verified_at,
    revokedAt: row.revoked_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    cardTypes: cardTypesOf(row),
    lastCheck,
  };
}

/** The rows of one scope (an org, or the platform for null) as DTOs, each with its current version's newest check. */
export async function withLastChecks(
  ctx: ServiceContext,
  orgId: string | null,
  rows: CredentialRow[],
): Promise<WalletCredential[]> {
  const checks = new Map(
    (
      await lastChecksOf(
        ctx.env.DB,
        orgId,
        rows.map((row) => row.id),
      )
    ).map((k) => [
      k.credential_id,
      k.ok === 1
        ? { ok: true as const, code: null, at: k.checked_at }
        : { ok: false as const, code: k.code ?? 'check_failed', at: k.checked_at },
    ]),
  );
  return rows.map((row) => credentialDto(row, checks.get(row.id) ?? null));
}

/** One row of the scope as a DTO. */
export async function withLastCheck(
  ctx: ServiceContext,
  orgId: string | null,
  row: CredentialRow,
): Promise<WalletCredential> {
  return (await withLastChecks(ctx, orgId, [row]))[0] as WalletCredential;
}

export const changed = () =>
  new ConflictError('The wallet credential changed. Reload and retry.', 'WALLET_ACCOUNT_CONFLICT');

function sessionOf(auth: SessionAuth): SessionAuth {
  if (auth?.kind !== 'session') throw new ForbiddenError();
  return auth;
}

/** The org's member writer: `integrations:manage`, a live session, the session's mode. */
export async function orgWriter(
  ctx: ServiceContext,
  auth: SessionAuth,
  orgId: string,
  purpose: string,
): Promise<CredentialWriter> {
  const authority = await tenantAuthorityOf(ctx, sessionOf(auth), orgId, 'integrations:manage');
  if (authority.kind !== 'session') throw new ForbiddenError();
  return {
    purpose,
    principal: tenantPrincipal(authority),
    checks: capabilityChecks(authority),
    actor: { type: 'user', id: authority.userId },
    platform: false,
  };
}

/** A key's event rows name the key as a `platform` actor: the event tables allow no other type. */
export function platformWriter(by: PlatformCaller, purpose: string): CredentialWriter {
  const session = isActor(by) ? null : sessionOf(by);
  if (session && !session.roles.includes('admin'))
    throw new ForbiddenError('Admin access is required.');
  return {
    purpose,
    principal: isActor(by)
      ? by.principal
      : { kind: 'platform', userId: by.userId, sessionIdHash: by.sessionId },
    checks: isActor(by) ? by.checks : [],
    actor: { type: 'platform', id: isActor(by) ? by.actorId : by.userId },
    platform: true,
  };
}

async function validate(input: SaveWalletCredential, now: number): Promise<void> {
  try {
    if (input.provider === 'google') await validateGoogleAccount(input.credentials);
    else await validateSamsungCredentials(input.credentials, now);
  } catch {
    throw new ValidationError(
      'Invalid wallet provider credentials.',
      [],
      'WALLET_CREDENTIALS_INVALID',
    );
  }
}

/** The identity (issuer or partner) and the card map entries this credential carries. */
async function identityOf(input: SaveWalletCredential) {
  if (input.provider === 'google')
    return { id: input.credentials.issuerId, cards: {} as Record<string, string> };
  return {
    id: input.credentials.partnerId,
    cards: await samsungCardMap(input.credentials),
  };
}

/** Creates or rotates the scope's one active credential for (mode, provider), always as a new version. */
export async function save(
  ctx: ServiceContext,
  w: CredentialWriter,
  scope: { orgId: string | null; mode: 'live' | 'test' },
  input: SaveWalletCredential,
  origin?: { provenance: 'managed' | 'own'; signerRef: string | null },
): Promise<CredentialRow> {
  const parsed = SaveWalletCredentialSchema.safeParse(input);
  if (!parsed.success)
    throw new ValidationError(
      'Invalid wallet provider credentials.',
      [],
      'WALLET_CREDENTIALS_INVALID',
    );
  const data = parsed.data;
  await validate(data, ctx.clock.now());
  const current = await findActiveCredential(ctx.env.DB, scope.orgId, scope.mode, data.provider);
  if ((current?.revision ?? 0) !== data.expectedRevision) throw changed();
  const identity = await identityOf(data);
  const identityHash = await credentialIdentityHash(data);
  if (current && current.identity_hash !== identityHash)
    throw new ConflictError('The provider identity cannot change.', 'WALLET_IDENTITY_IMMUTABLE');
  const previous = await cardMapOf(ctx.env.DB, current?.current_version_id ?? null);
  // Card ids are append-only: a rotation keeps every type's card.
  for (const [type, hash] of Object.entries(previous))
    if (identity.cards[type] !== hash)
      throw new ConflictError('The provider identity cannot change.', 'WALLET_IDENTITY_IMMUTABLE');
  const credentialId = current?.id ?? ctx.ids.id();
  const versionId = ctx.ids.id();
  const kind = `wallet-credential:${credentialId}:${w.platform ? 'platform' : 'org'}:${scope.mode}:${data.provider}`;
  const envelope = await encryptSecret(
    await loadKekRing(ctx.env),
    JSON.stringify({ version: 1, provider: data.provider, credentials: data.credentials }),
    credentialAad(versionId, scope.orgId, kind),
  );
  await saveCredential(ctx, w, {
    credentialId,
    expectedRevision: data.expectedRevision,
    mode: scope.mode,
    provider: data.provider,
    identityHash,
    identityHint: identity.id.slice(-4),
    versionId,
    eventId: ctx.ids.id(),
    cardMap: { ...previous, ...identity.cards },
    envelope,
    ...(origin ? { origin } : {}),
    ...(!origin && current?.signer_ref ? { clearSigner: true as const } : {}),
  });
  await enqueueVersionCheck(ctx, credentialId, versionId);
  const saved = await findCredential(ctx.env.DB, credentialId, scope.orgId);
  if (!saved) throw changed();
  return saved;
}

async function revoke(
  ctx: ServiceContext,
  w: CredentialWriter,
  row: CredentialRow | null,
  input: RevokeWalletCredential,
): Promise<CredentialRow> {
  if (!row) throw new NotFoundError();
  if (row.revoked_at !== null || row.revision !== input.expectedRevision) throw changed();
  await revokeCredential(ctx, w, {
    credentialId: row.id,
    expectedRevision: row.revision,
    eventId: ctx.ids.id(),
  });
  const done = await findCredential(ctx.env.DB, row.id, row.org_id);
  if (!done) throw changed();
  return done;
}

export async function listOrgCredentials(
  ctx: ServiceContext,
  auth: SessionAuth,
  orgId: string,
  provider?: 'google' | 'samsung',
): Promise<WalletCredentialList> {
  await tenantAuthorityOf(ctx, sessionOf(auth), orgId, 'integrations:read');
  const rows = await listCredentials(ctx.env.DB, {
    orgId,
    mode: auth.mode,
    ...(provider ? { provider } : {}),
  });
  return { items: await withLastChecks(ctx, orgId, rows), nextCursor: null };
}

export async function saveOrgCredential(
  ctx: ServiceContext,
  auth: SessionAuth,
  orgId: string,
  input: SaveWalletCredential,
): Promise<WalletCredential> {
  ctx = snapshotWalletCredentialContext(ctx);
  const w = await orgWriter(ctx, auth, orgId, 'org_mode.wallet.credential_save');
  return withLastCheck(ctx, orgId, await save(ctx, w, { orgId, mode: auth.mode }, input));
}

export async function revokeOrgCredential(
  ctx: ServiceContext,
  auth: SessionAuth,
  orgId: string,
  id: string,
  input: RevokeWalletCredential,
): Promise<WalletCredential> {
  const w = await orgWriter(ctx, auth, orgId, 'org_mode.wallet.credential_revoke');
  const row = await findCredential(ctx.env.DB, id, orgId);
  // A credential of the other mode is not this session's to revoke.
  return withLastCheck(
    ctx,
    orgId,
    await revoke(ctx, w, row?.mode === auth.mode ? row : null, input),
  );
}

export async function listPlatformCredentials(
  ctx: ServiceContext,
  auth: PlatformCaller,
): Promise<PlatformWalletCredentialList> {
  platformWriter(auth, 'platform.wallet.credential_save');
  return {
    items: await withLastChecks(ctx, null, await listCredentials(ctx.env.DB, { orgId: null })),
    nextCursor: null,
    release: walletReleaseByMode(),
  };
}

export async function savePlatformCredential(
  ctx: ServiceContext,
  auth: PlatformCaller,
  input: SaveWalletCredential & { mode: 'live' | 'test' },
): Promise<WalletCredential> {
  ctx = snapshotWalletCredentialContext(ctx);
  const w = platformWriter(auth, 'platform.wallet.credential_save');
  const { mode, ...rest } = input;
  return withLastCheck(
    ctx,
    null,
    await save(ctx, w, { orgId: null, mode }, rest as SaveWalletCredential),
  );
}

export async function revokePlatformCredential(
  ctx: ServiceContext,
  auth: PlatformCaller,
  id: string,
  input: RevokeWalletCredential,
): Promise<WalletCredential> {
  const w = platformWriter(auth, 'platform.wallet.credential_revoke');
  return withLastCheck(
    ctx,
    null,
    await revoke(ctx, w, await findCredential(ctx.env.DB, id, null), input),
  );
}
