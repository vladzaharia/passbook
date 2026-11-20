import type {
  SetWalletEnrolmentSource,
  WalletEnrolment,
  WalletEnrolmentAction,
} from '../../../shared/contracts/wallet-providers.ts';
import { featureNotIncluded } from '../../../shared/copy/entitlements.ts';
import type { SessionAuth } from '../../platform/auth.ts';
import { grant } from '../../platform/authority.ts';
import type { Check } from '../../platform/authority-checks.ts';
import { entitled } from '../../platform/authority-entitled.ts';
import type { Principal } from '../../platform/authority-principal.ts';
import { entitlementsOf, isEntitled } from '../../platform/entitlements.ts';
import { ConflictError, FeatureNotIncludedError, ForbiddenError } from '../../platform/errors.ts';
import type { ServiceContext } from '../../platform/service-context.ts';
import { tenantAuthorityOf } from '../passes/http.ts';
import { capabilityChecks, tenantPrincipal } from '../passes/repo-authority.ts';
import { enrolmentView } from './enrolment-read.ts';
import { newEnrolmentKeyColumns } from './enrolment-source-key.ts';
import { credentialById, findActiveCredential } from './repo-credentials.ts';
import {
  commitEnrolmentStep,
  ENROLMENT_TABLES,
  type EnrolmentRow,
  type EnrolmentStep,
  findEnrolment,
  freshCheckId,
  testRoundTrip,
} from './repo-enrolments.ts';
import { type Prerequisite, prerequisite } from './wallet-write-errors.ts';

type Mode = 'live' | 'test';
type Provider = 'google' | 'samsung';

const changed = (message = 'The wallet account changed. Reload and retry.') =>
  new ConflictError(message, 'WALLET_ACCOUNT_CONFLICT');
const held = () => new ConflictError('The platform holds this enrolment.', 'WALLET_ENROLMENT_HELD');

function sessionOf(auth: SessionAuth): SessionAuth {
  if (auth?.kind !== 'session') throw new ForbiddenError();
  return auth;
}

interface OrgWriter {
  principal: Principal;
  checks: ReturnType<typeof capabilityChecks>;
  userId: string;
}

async function orgWriter(
  ctx: ServiceContext,
  auth: SessionAuth,
  orgId: string,
): Promise<OrgWriter> {
  const authority = await tenantAuthorityOf(ctx, sessionOf(auth), orgId, 'integrations:manage');
  if (authority.kind !== 'session') throw new ForbiddenError();
  return {
    principal: tenantPrincipal(authority),
    checks: capabilityChecks(authority),
    userId: authority.userId,
  };
}

/** The row the caller read, at the revision it read; an absent row reads as revision 0. */
async function current(
  ctx: ServiceContext,
  orgId: string,
  mode: Mode,
  provider: Provider,
  expectedRevision: number,
): Promise<EnrolmentRow | null> {
  const row = await findEnrolment(ctx.env.DB, orgId, mode, provider);
  if ((row?.enrolment_revision ?? 0) !== expectedRevision) throw changed();
  // A legacy row keeps its configure path until it is migrated onto a source.
  if (row?.credential_id && row.credential_source_id === null)
    throw changed('This account has not been migrated yet.');
  return row;
}

async function orgStep(
  ctx: ServiceContext,
  auth: SessionAuth,
  orgId: string,
  provider: Provider,
  purpose: string,
  step: (w: OrgWriter) => EnrolmentStep,
  extra: Check[] = [],
): Promise<WalletEnrolment> {
  const w = await orgWriter(ctx, auth, orgId);
  const g = grant(ctx, {
    purpose,
    principal: w.principal,
    checks: [...w.checks, ...extra],
    tables: ENROLMENT_TABLES,
    codes: { config: 'WALLET_ACCOUNT_CONFLICT' },
  });
  await commitEnrolmentStep(ctx, g, step(w));
  return enrolmentView(
    ctx,
    orgId,
    auth.mode,
    provider,
    await findEnrolment(ctx.env.DB, orgId, auth.mode, provider),
  );
}

export async function setEnrolmentSource(
  ctx: ServiceContext,
  auth: SessionAuth,
  orgId: string,
  provider: Provider,
  input: SetWalletEnrolmentSource,
): Promise<WalletEnrolment> {
  const mode = sessionOf(auth).mode;
  await tenantAuthorityOf(ctx, auth, orgId, 'integrations:manage');
  const row = await current(ctx, orgId, mode, provider, input.expectedRevision);
  if (row?.revoked_at != null) throw changed();
  const source = await findActiveCredential(
    ctx.env.DB,
    input.source === 'platform' ? null : orgId,
    mode,
    provider,
  );
  if (!source?.current_version_id) throw prerequisite(['source']);
  // A migrated row keeps its identity until PE3 pins candidates to it: the migration resolves a collision with the
  // same identity only, so a switch to another issuer fails closed.
  if (row?.credential_id && row.identity_hash !== source.identity_hash)
    throw new ConflictError('The provider identity cannot change.', 'WALLET_IDENTITY_IMMUTABLE');
  const accountId = row?.id ?? ctx.ids.id();
  // A new-model Google enrolment gets its own key with its first source; a row with a legacy envelope keeps that key.
  const ownKey =
    provider !== 'google' || row?.has_hmac || row?.credential_id
      ? {}
      : await newEnrolmentKeyColumns(ctx, { id: accountId, orgId, mode, provider });
  return orgStep(ctx, auth, orgId, provider, 'org_mode.wallet.enrolment_source', (w) => ({
    accountId,
    isNew: row === null,
    provider,
    expectedRevision: input.expectedRevision,
    revision: input.expectedRevision + 1,
    event: {
      id: ctx.ids.id(),
      kind: 'source',
      credentialId: source.id,
      actor: { type: 'user', id: w.userId },
    },
    // A switch turns the enrolment Off in the same update.
    set: {
      credential_source_id: source.id,
      identity_hash: source.identity_hash,
      enabled_at: null,
      ...ownKey,
    },
  }));
}

export async function enableEnrolment(
  ctx: ServiceContext,
  auth: SessionAuth,
  orgId: string,
  provider: Provider,
  input: WalletEnrolmentAction,
): Promise<WalletEnrolment> {
  const mode = sessionOf(auth).mode;
  await tenantAuthorityOf(ctx, auth, orgId, 'integrations:manage');
  // The plan first, in Test and Live alike: a plan without the wallet must not read as a missing prerequisite.
  const feature = `wallet.${provider}` as const;
  if (!isEntitled(await entitlementsOf(ctx, orgId), feature))
    throw new FeatureNotIncludedError(feature, featureNotIncluded(feature));
  const row = await current(ctx, orgId, mode, provider, input.expectedRevision);
  if (!row?.credential_source_id || row.revoked_at !== null || row.enabled_at !== null)
    throw changed();
  if (row.platform_hold_at !== null) throw held();
  const source = await credentialById(ctx.env.DB, row.credential_source_id);
  if (!source || source.revoked_at !== null || !source.current_version_id)
    throw prerequisite(['source']);
  const missing: Prerequisite[] = [];
  if (source.scope === 'org' && source.verified_at === null) missing.push('verified');
  const now = ctx.clock.now();
  const checkId = await freshCheckId(ctx.env.DB, source.id, source.current_version_id, now);
  if (checkId === null) missing.push('check');
  const roundTrip = mode === 'live' ? await testRoundTrip(ctx.env.DB, orgId, provider) : null;
  if (mode === 'live' && roundTrip === null) missing.push('round_trip');
  if (missing.length > 0 || checkId === null) throw prerequisite(missing);
  return orgStep(
    ctx,
    auth,
    orgId,
    provider,
    'org_mode.wallet.enrolment_enable',
    (w) => ({
      accountId: row.id,
      isNew: false,
      provider,
      expectedRevision: row.enrolment_revision,
      revision: row.enrolment_revision + 1,
      event: {
        id: ctx.ids.id(),
        kind: 'enable',
        credentialId: source.id,
        checkId,
        ...(roundTrip ? { roundTrip } : {}),
        actor: { type: 'user', id: w.userId },
        createdAt: now,
      },
      set: { enabled_at: now },
    }),
    [entitled(feature)],
  );
}

export async function disableEnrolment(
  ctx: ServiceContext,
  auth: SessionAuth,
  orgId: string,
  provider: Provider,
  input: WalletEnrolmentAction,
): Promise<WalletEnrolment> {
  const mode = sessionOf(auth).mode;
  await tenantAuthorityOf(ctx, auth, orgId, 'integrations:manage');
  const row = await current(ctx, orgId, mode, provider, input.expectedRevision);
  if (!row || row.enabled_at === null) throw changed();
  return orgStep(ctx, auth, orgId, provider, 'org_mode.wallet.enrolment_disable', (w) => ({
    accountId: row.id,
    isNew: false,
    provider,
    expectedRevision: row.enrolment_revision,
    revision: row.enrolment_revision + 1,
    event: { id: ctx.ids.id(), kind: 'disable', actor: { type: 'user', id: w.userId } },
    set: { enabled_at: null },
  }));
}

export async function revokeEnrolment(
  ctx: ServiceContext,
  auth: SessionAuth,
  orgId: string,
  provider: Provider,
  input: WalletEnrolmentAction,
): Promise<WalletEnrolment> {
  const mode = sessionOf(auth).mode;
  await tenantAuthorityOf(ctx, auth, orgId, 'integrations:manage');
  const row = await current(ctx, orgId, mode, provider, input.expectedRevision);
  if (!row || row.revoked_at !== null) throw changed();
  if (row.enabled_at !== null) throw changed('Turn the provider off first.');
  const at = ctx.clock.now();
  return orgStep(ctx, auth, orgId, provider, 'org_mode.wallet.enrolment_revoke', (w) => ({
    accountId: row.id,
    isNew: false,
    provider,
    expectedRevision: row.enrolment_revision,
    revision: row.enrolment_revision + 1,
    event: {
      id: ctx.ids.id(),
      kind: 'revoke',
      actor: { type: 'user', id: w.userId },
      createdAt: at,
    },
    set: { revoked_at: at },
  }));
}
