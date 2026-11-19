import type {
  ResolveWalletMigration,
  WalletProviderScope,
} from '../../../shared/contracts/wallet-providers.ts';
import type { SessionAuth } from '../../platform/auth.ts';
import { type Grant, grant } from '../../platform/authority.ts';
import { type Check, epochIs } from '../../platform/authority-checks.ts';
import { ConflictError, NotFoundError } from '../../platform/errors.ts';
import type { ServiceContext } from '../../platform/service-context.ts';
import { snapshotWalletCredentialContext } from './account-credential-material.ts';
import { credentialIdentityHash, openSourceVersion } from './account-credential-source.ts';
import { adminOnly, commitSource, type Legacy, openLegacy } from './credential-migrate.ts';
import { savePlatformCredential } from './credential-service.ts';
import { adminOf } from './enrolment-hold.ts';
import { findCurrentSourceVersion } from './repo-account-source.ts';
import { type AccountRow, hasUnretiredInstances } from './repo-accounts.ts';
import {
  accountAt,
  accountsOnOrgIdentity,
  findLegacy,
  pendingAccounts,
  retireLegacy,
} from './repo-credential-migrate.ts';
import {
  CREDENTIAL_TABLES,
  type CredentialRow,
  credentialById,
  findActiveCredential,
  stageCredentialRevoke,
} from './repo-credentials.ts';
import { ENROLMENT_TABLES, type EnrolmentRow, findEnrolment } from './repo-enrolments.ts';
import { prerequisite } from './wallet-write-errors.ts';

const TABLES = [...CREDENTIAL_TABLES, ...ENROLMENT_TABLES, 'wallet_provider_account_events'];
const changed = (message = 'The wallet account changed. Reload and retry.') =>
  new ConflictError(message, 'WALLET_ACCOUNT_CONFLICT');

interface Target {
  legacyRow: AccountRow;
  row: EnrolmentRow;
}

async function targetOf(ctx: ServiceContext, scope: WalletProviderScope): Promise<Target> {
  const legacyRow = await findLegacy(ctx.env.DB, scope.orgId, scope.mode, scope.provider);
  const row = await findEnrolment(ctx.env.DB, scope.orgId, scope.mode, scope.provider);
  if (!legacyRow || !row || row.credential_id === null) throw new NotFoundError();
  if (row.revoked_at !== null) throw changed();
  return { legacyRow, row };
}

/** The grant of a resolution: a platform admin naming the account's org and mode. */
function resolveGrant(
  ctx: ServiceContext,
  auth: SessionAuth,
  scope: WalletProviderScope,
  checks: Check[],
): Grant {
  return grant(ctx, {
    purpose: 'org_mode.wallet.migration_resolve',
    principal: adminOf(auth, scope),
    tables: TABLES,
    checks,
    codes: { config: 'WALLET_ACCOUNT_CONFLICT' },
  });
}

/** One audit row in the resolution's batch. */
function auditOf(
  ctx: ServiceContext,
  userId: string,
  row: EnrolmentRow,
  action: ResolveWalletMigration['action'],
) {
  return (g: Grant) =>
    void g.audit({
      at: ctx.clock.now(),
      orgId: row.org_id,
      actorType: 'user',
      actorId: userId,
      action: 'wallet_provider.migration_resolve',
      targetType: 'wallet_provider_account',
      targetId: row.id,
      requestId: ctx.requestId,
      ipPrefix: null,
      detail: JSON.stringify({ mode: row.mode, provider: row.provider, action }),
    });
}

/** The identity the account stands on: its v1 envelope when pending, else its source's own secret. */
async function identityOf(
  ctx: ServiceContext,
  t: Target,
): Promise<{ hash: string; legacy: Legacy | null; secret: Legacy['source'] }> {
  if (t.row.credential_source_id === null) {
    const legacy = await openLegacy(ctx, t.legacyRow);
    return { hash: await credentialIdentityHash(legacy.source), legacy, secret: legacy.source };
  }
  const version = await findCurrentSourceVersion(ctx.env.DB, {
    id: t.row.id,
    orgId: t.row.org_id,
    mode: t.row.mode,
    provider: t.row.provider,
  });
  if (!version) throw changed();
  const opened = await openSourceVersion(
    ctx,
    { id: t.row.id, orgId: t.row.org_id, mode: t.row.mode, provider: t.row.provider },
    version,
  );
  return { hash: opened.identityHash, legacy: null, secret: opened };
}

/** Points one account at the platform credential; the old org credential goes with it when `retireOld` names it. */
async function pointAtPlatform(
  ctx: ServiceContext,
  auth: SessionAuth,
  t: Target,
  platform: CredentialRow,
  action: ResolveWalletMigration['action'],
  legacy: Legacy | null,
): Promise<void> {
  const { userId } = adminOnly(auth);
  const scope = { orgId: t.row.org_id, mode: t.row.mode, provider: t.row.provider };
  const old = t.row.credential_source_id
    ? await credentialById(ctx.env.DB, t.row.credential_source_id)
    : null;
  const dropOld =
    action === 'merge' && old !== null && old.scope === 'org' && old.revoked_at === null;
  const g = resolveGrant(ctx, auth, scope, [
    accountAt(t.row.id, 'enrolment_revision', t.row.enrolment_revision),
    ...(dropOld ? [epochIs('wallet_credentials', old.id, 'revision', old.revision)] : []),
  ]);
  const audit = auditOf(ctx, userId, t.row, action);
  await commitSource(
    ctx,
    g,
    t.row,
    legacy,
    { kind: 'existing', credential: platform },
    { type: 'platform', id: userId },
    (grantNow) => {
      audit(grantNow);
      if (dropOld)
        stageCredentialRevoke(
          grantNow,
          ctx,
          { actor: { type: 'platform', id: userId }, platform: false },
          { credentialId: old.id, expectedRevision: old.revision, eventId: ctx.ids.id() },
        );
    },
  );
}

async function assignPlatform(ctx: ServiceContext, auth: SessionAuth, t: Target): Promise<number> {
  const platform = await findActiveCredential(ctx.env.DB, null, t.row.mode, t.row.provider);
  if (!platform?.current_version_id) throw prerequisite(['source']);
  if (t.row.credential_source_id === platform.id) throw changed();
  const id = await identityOf(ctx, t);
  if (id.hash !== platform.identity_hash)
    throw new ConflictError('The provider identity cannot change.', 'WALLET_IDENTITY_IMMUTABLE');
  await pointAtPlatform(ctx, auth, t, platform, 'assign_platform', id.legacy);
  return 1;
}

/**
 * Promotes the shared identity to a platform credential, then points every account on it (pending, or
 * migrated onto an org credential of that identity) at it and revokes the duplicate org credentials. A rerun
 * after a crash finds the platform credential and finishes the rest.
 */
async function merge(ctx: ServiceContext, auth: SessionAuth, t: Target): Promise<number> {
  const { mode, provider } = t.row;
  const id = await identityOf(ctx, t);
  let platform = await findActiveCredential(ctx.env.DB, null, mode, provider);
  if (platform && platform.identity_hash !== id.hash)
    throw changed('A platform credential with another identity exists. Assign or retire instead.');
  if (!platform) {
    await savePlatformCredential(ctx, auth, {
      mode,
      provider,
      expectedRevision: 0,
      credentials: id.secret.credentials,
    } as Parameters<typeof savePlatformCredential>[2]);
    platform = await findActiveCredential(ctx.env.DB, null, mode, provider);
  }
  if (!platform?.current_version_id) throw changed();
  const accounts = new Map<string, Target>([[t.row.id, t]]);
  for (let after = ''; ; ) {
    const page = await pendingAccounts(ctx.env.DB, after, 100, { mode, provider });
    if (page.length === 0) break;
    after = page[page.length - 1]?.id ?? '';
    for (const p of page) {
      if (accounts.has(p.id)) continue;
      const other = await targetOf(ctx, { orgId: p.org_id, mode, provider });
      if ((await identityOf(ctx, other)).hash === id.hash) accounts.set(p.id, other);
    }
  }
  for (const m of await accountsOnOrgIdentity(ctx.env.DB, mode, provider, id.hash))
    if (!accounts.has(m.id))
      accounts.set(m.id, await targetOf(ctx, { orgId: m.org_id, mode, provider }));
  let moved = 0;
  for (const a of accounts.values()) {
    if (a.row.credential_source_id === platform.id) continue;
    await pointAtPlatform(ctx, auth, a, platform, 'merge', (await identityOf(ctx, a)).legacy);
    moved += 1;
  }
  return moved;
}

async function retire(ctx: ServiceContext, auth: SessionAuth, t: Target): Promise<number> {
  const { userId } = adminOnly(auth);
  if (await hasUnretiredInstances(ctx.env.DB, t.row.id))
    throw new ConflictError(
      'Retire all provider instances before revoking this account.',
      'WALLET_ACCOUNT_INSTANCES_ACTIVE',
    );
  const scope = { orgId: t.row.org_id, mode: t.row.mode, provider: t.row.provider };
  const g = resolveGrant(ctx, auth, scope, [accountAt(t.row.id, 'revision', t.legacyRow.revision)]);
  auditOf(ctx, userId, t.row, 'retire')(g);
  await retireLegacy(ctx, g, t.legacyRow, userId);
  return 1;
}

/** A platform admin's resolution of a refused account: assign the platform credential, merge, or retire. */
export async function resolveMigration(
  ctx: ServiceContext,
  auth: SessionAuth,
  input: ResolveWalletMigration,
): Promise<{ accounts: number }> {
  adminOnly(auth);
  ctx = snapshotWalletCredentialContext(ctx);
  const t = await targetOf(ctx, input);
  const accounts =
    input.action === 'retire'
      ? await retire(ctx, auth, t)
      : input.action === 'merge'
        ? await merge(ctx, auth, t)
        : await assignPlatform(ctx, auth, t);
  return { accounts };
}
