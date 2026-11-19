import type {
  SetWalletEnrolmentSource,
  WalletEnrolment,
  WalletEnrolmentAction,
  WalletEnrolmentList,
} from '../../../shared/contracts/wallet-providers.ts';
import type { SessionAuth } from '../../platform/auth.ts';
import { grant, jobGrant } from '../../platform/authority.ts';
import type { Principal } from '../../platform/authority-principal.ts';
import { ConflictError, ForbiddenError, NotFoundError } from '../../platform/errors.ts';
import type { ServiceContext } from '../../platform/service-context.ts';
import { tenantAuthorityOf } from '../passes/http.ts';
import { capabilityChecks, tenantPrincipal } from '../passes/repo-authority.ts';
import { walletProviderIssuance } from './provider-policy.ts';
import { credentialById, findActiveCredential } from './repo-credentials.ts';
import {
  commitEnrolmentStep,
  ENROLMENT_TABLES,
  type EnrolmentRow,
  type EnrolmentStep,
  enrolmentsOf,
  findEnrolment,
  freshCheckId,
  maxEventRevision,
  orgStatus,
  testRoundTrip,
} from './repo-enrolments.ts';
import { type Prerequisite, prerequisite } from './wallet-write-errors.ts';

type Mode = 'live' | 'test';
type Provider = 'google' | 'samsung';

const PROVIDERS: Provider[] = ['google', 'samsung'];
const changed = (message = 'The wallet account changed. Reload and retry.') =>
  new ConflictError(message, 'WALLET_ACCOUNT_CONFLICT');
const held = () => new ConflictError('The platform holds this enrolment.', 'WALLET_ENROLMENT_HELD');

function sessionOf(auth: SessionAuth): SessionAuth {
  if (auth?.kind !== 'session') throw new ForbiddenError();
  return auth;
}

async function enrolmentView(
  ctx: ServiceContext,
  orgId: string,
  mode: Mode,
  provider: Provider,
  row: EnrolmentRow | null,
): Promise<WalletEnrolment> {
  const db = ctx.env.DB;
  const platform = await findActiveCredential(db, null, mode, provider);
  const source = row?.credential_source_id
    ? await credentialById(db, row.credential_source_id)
    : null;
  const check =
    source?.current_version_id && source.revoked_at === null
      ? (await freshCheckId(db, source.id, source.current_version_id, ctx.clock.now())) !== null
      : false;
  const roundTrip = mode === 'live' ? (await testRoundTrip(db, orgId, provider)) !== null : null;
  const state =
    !row?.credential_source_id && row?.revoked_at == null
      ? 'absent'
      : row?.revoked_at != null
        ? 'revoked'
        : row?.platform_hold_at != null
          ? 'held'
          : row?.enabled_at != null
            ? 'on'
            : 'off';
  return {
    mode,
    provider,
    accountId: row?.id ?? null,
    source: source ? source.scope : null,
    platformAvailable: platform?.current_version_id != null,
    state,
    enrolmentRevision: row?.enrolment_revision ?? 0,
    prerequisites: { check, roundTrip },
    hold:
      row?.platform_hold_at != null
        ? { at: row.platform_hold_at, reason: row.platform_hold_reason ?? '' }
        : null,
    issuance: walletProviderIssuance(provider),
  };
}

export async function listEnrolments(
  ctx: ServiceContext,
  auth: SessionAuth,
  orgId: string,
): Promise<WalletEnrolmentList> {
  await tenantAuthorityOf(ctx, sessionOf(auth), orgId, 'integrations:read');
  const rows = await enrolmentsOf(ctx.env.DB, orgId, auth.mode);
  const items: WalletEnrolment[] = [];
  for (const provider of PROVIDERS)
    items.push(
      await enrolmentView(
        ctx,
        orgId,
        auth.mode,
        provider,
        rows.find((r) => r.provider === provider) ?? null,
      ),
    );
  return { items };
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
): Promise<WalletEnrolment> {
  const w = await orgWriter(ctx, auth, orgId);
  const g = grant(ctx, {
    purpose,
    principal: w.principal,
    checks: w.checks,
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
  const accountId = row?.id ?? ctx.ids.id();
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
    set: { credential_source_id: source.id, identity_hash: source.identity_hash, enabled_at: null },
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
  return orgStep(ctx, auth, orgId, provider, 'org_mode.wallet.enrolment_enable', (w) => ({
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
  }));
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

export interface HoldScope {
  orgId: string;
  mode: Mode;
  provider: Provider;
}

function adminOf(auth: SessionAuth, scope: HoldScope): Extract<Principal, { kind: 'platform' }> {
  const session = sessionOf(auth);
  if (!session.roles.includes('admin')) throw new ForbiddenError('Admin access is required.');
  return {
    kind: 'platform',
    userId: session.userId,
    sessionIdHash: session.sessionId,
    orgId: scope.orgId,
    mode: scope.mode,
  };
}

/** A hold or release steps past the highest event, so a stray event at the next revision cannot block it. */
async function platformStep(
  ctx: ServiceContext,
  row: EnrolmentRow,
  scope: HoldScope,
  kind: 'hold' | 'release',
  userId: string,
  reason: string | undefined,
): Promise<EnrolmentStep> {
  const at = ctx.clock.now();
  return {
    accountId: row.id,
    isNew: false,
    provider: scope.provider,
    expectedRevision: row.enrolment_revision,
    revision: Math.max(row.enrolment_revision, await maxEventRevision(ctx.env.DB, row.id)) + 1,
    event: {
      id: ctx.ids.id(),
      kind,
      ...(reason ? { reason } : {}),
      actor: { type: 'platform', id: userId },
      createdAt: at,
    },
    set:
      kind === 'hold'
        ? { enabled_at: null, platform_hold_at: at, platform_hold_reason: reason ?? null }
        : { platform_hold_at: null, platform_hold_reason: null },
  };
}

async function heldRow(
  ctx: ServiceContext,
  scope: HoldScope,
  wantHeld: boolean,
): Promise<EnrolmentRow> {
  const row = await findEnrolment(ctx.env.DB, scope.orgId, scope.mode, scope.provider);
  if (!row) throw new NotFoundError();
  if (row.revoked_at !== null || (row.platform_hold_at !== null) !== wantHeld) throw changed();
  return row;
}

/** Holds an enrolment. A suspended org takes the hold through its job; `queued` says so. */
export async function holdEnrolment(
  ctx: ServiceContext,
  auth: SessionAuth,
  scope: HoldScope,
  reason: string,
): Promise<'held' | 'queued'> {
  const principal = adminOf(auth, scope);
  const row = await heldRow(ctx, scope, false);
  const status = await orgStatus(ctx.env.DB, scope.orgId);
  if (status === 'suspended') {
    await ctx.env.JOBS.send({
      kind: 'wallet.enrolment_hold',
      ...scope,
      reason,
      userId: principal.userId,
    });
    return 'queued';
  }
  const g = grant(ctx, {
    purpose: 'org_mode.wallet.enrolment_hold',
    principal,
    tables: ENROLMENT_TABLES,
    codes: { config: 'WALLET_ACCOUNT_CONFLICT' },
  });
  await commitEnrolmentStep(
    ctx,
    g,
    await platformStep(ctx, row, scope, 'hold', principal.userId, reason),
  );
  return 'held';
}

export async function releaseEnrolment(
  ctx: ServiceContext,
  auth: SessionAuth,
  scope: HoldScope,
): Promise<'released'> {
  const principal = adminOf(auth, scope);
  const row = await heldRow(ctx, scope, true);
  const g = grant(ctx, {
    purpose: 'org_mode.wallet.enrolment_release',
    principal,
    tables: ENROLMENT_TABLES,
    codes: { config: 'WALLET_ACCOUNT_CONFLICT' },
  });
  await commitEnrolmentStep(
    ctx,
    g,
    await platformStep(ctx, row, scope, 'release', principal.userId, undefined),
  );
  return 'released';
}

/** The hold of a suspended org, as a job: the event and the audit row name the platform user who asked. */
export async function runEnrolmentHold(
  ctx: ServiceContext,
  job: HoldScope & { reason: string; userId: string },
): Promise<void> {
  const row = await findEnrolment(ctx.env.DB, job.orgId, job.mode, job.provider);
  if (!row || row.revoked_at !== null || row.platform_hold_at !== null) return;
  const g = jobGrant(ctx, {
    purpose: 'org_mode.job.wallet.enrolment_hold',
    job: 'wallet',
    orgId: job.orgId,
    mode: job.mode,
    inactiveOk: true,
    tables: ENROLMENT_TABLES,
  });
  await commitEnrolmentStep(
    ctx,
    g,
    await platformStep(ctx, row, job, 'hold', job.userId, job.reason),
  );
}
