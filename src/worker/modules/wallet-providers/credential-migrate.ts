import type {
  WalletMigrationReport,
  WalletProviderScope,
} from '../../../shared/contracts/wallet-providers.ts';
import type { SessionAuth } from '../../platform/auth.ts';
import type { Grant } from '../../platform/authority.ts';
import { jobGrant } from '../../platform/authority.ts';
import type { Check } from '../../platform/authority-checks.ts';
import { credentialAad, encryptSecret, loadKekRing } from '../../platform/crypto.ts';
import { classifyD1Error } from '../../platform/db.ts';
import { ForbiddenError } from '../../platform/errors.ts';
import type { ServiceContext } from '../../platform/service-context.ts';
import { accountHmacKind } from '../keys/rewrap-tables.ts';
import { decryptAccount, snapshotWalletCredentialContext } from './account-credential-material.ts';
import { credentialIdentityHash, type SourceCredentials } from './account-credential-source.ts';
import { isActor, type PlatformCaller } from './platform-caller.ts';
import {
  accountAt,
  countAccounts,
  findPending,
  noRivalCredential,
  pendingAccounts,
  rivalOrgs,
  unprovenOrgs,
} from './repo-credential-migrate.ts';
import {
  CREDENTIAL_TABLES,
  type CredentialRow,
  findActiveCredential,
  stageCredentialSave,
} from './repo-credentials.ts';
import {
  commitEnrolmentStep,
  ENROLMENT_TABLES,
  type EnrolmentRow,
  findEnrolment,
} from './repo-enrolments.ts';
import { samsungCardMap } from './samsung-cards.ts';

type Mode = 'live' | 'test';
type Provider = 'google' | 'samsung';

/** The v1 envelope's contents: the provider secret, and the Google HMAC key the ids derive from. */
export interface Legacy {
  source: SourceCredentials;
  hmacKey: string | null;
}

export type Plan =
  | { kind: 'existing'; credential: CredentialRow }
  | {
      kind: 'create';
      identityHash: string;
      hint: string;
      cardMap: Record<string, string>;
      secret: SourceCredentials;
      /** Other orgs' unverified claims of the identity: they never block, the report names them. */
      unproven: WalletProviderScope[];
    }
  | {
      kind: 'refused';
      reason: 'identity_shared' | 'org_credential_exists';
      shared: WalletProviderScope[];
    };

export interface MigrateScope {
  id: string;
  org_id: string;
  mode: Mode;
  provider: Provider;
}

export async function openLegacy(
  ctx: ServiceContext,
  row: Parameters<typeof decryptAccount>[1],
): Promise<Legacy> {
  const stored = await decryptAccount(ctx, row);
  return stored.provider === 'google'
    ? {
        source: { provider: 'google', credentials: stored.credentials },
        hmacKey: stored.objectIdHmacKey,
      }
    : { source: { provider: 'samsung', credentials: stored.credentials }, hmacKey: null };
}

/** A platform route's caller: an admin session, or the gate's `Actor` (a platform admin or a Platform key). */
export function platformCaller(by: PlatformCaller): void {
  if (!isActor(by)) adminOnly(by);
}

export function adminOnly(auth: SessionAuth): { userId: string } {
  if (auth?.kind !== 'session' || !auth.roles.includes('admin'))
    throw new ForbiddenError('Admin access is required.');
  return { userId: auth.userId };
}

const identityOf = (s: SourceCredentials) =>
  s.provider === 'google' ? s.credentials.issuerId : s.credentials.partnerId;

/**
 * Where the account's secret goes: the platform credential of the same identity (nothing created), the
 * org's own credential of that identity, or a new unverified org credential. Another org's credential of the
 * identity refuses it, verified or not: the owner picks assign, merge or retire.
 */
export async function planSource(
  ctx: ServiceContext,
  a: MigrateScope,
  secret: SourceCredentials,
): Promise<Plan> {
  const db = ctx.env.DB;
  const identityHash = await credentialIdentityHash(secret);
  const platform = await findActiveCredential(db, null, a.mode, a.provider);
  if (platform?.current_version_id && platform.identity_hash === identityHash)
    return { kind: 'existing', credential: platform };
  const own = await findActiveCredential(db, a.org_id, a.mode, a.provider);
  if (own)
    return own.current_version_id && own.identity_hash === identityHash
      ? { kind: 'existing', credential: own }
      : { kind: 'refused', reason: 'org_credential_exists', shared: [] };
  const rivals = await rivalOrgs(db, a.org_id, a.mode, a.provider, identityHash);
  if (rivals.length > 0)
    return {
      kind: 'refused',
      reason: 'identity_shared',
      shared: rivals.map((r) => ({ orgId: r.org_id, mode: a.mode, provider: a.provider })),
    };
  return {
    kind: 'create',
    identityHash,
    hint: identityOf(secret).slice(-4),
    cardMap: secret.provider === 'samsung' ? await samsungCardMap(secret.credentials) : {},
    secret,
    unproven: (await unprovenOrgs(db, a.org_id, a.mode, a.provider, identityHash)).map((r) => ({
      orgId: r.org_id,
      mode: a.mode,
      provider: a.provider,
    })),
  };
}

/** The account's own HMAC key columns, copied from the v1 envelope (ids unchanged); none for Samsung or a row that has one. */
async function keyColumns(ctx: ServiceContext, row: EnrolmentRow, legacy: Legacy | null) {
  if (!legacy?.hmacKey || row.has_hmac) return {};
  const e = await encryptSecret(
    await loadKekRing(ctx.env),
    legacy.hmacKey,
    credentialAad(row.id, row.org_id, accountHmacKind(row.id, row.mode, row.provider)),
  );
  return {
    hmac_kek_version: e.kekVersion,
    hmac_iv: e.iv,
    hmac_wrapped_dek: e.wrappedDek,
    hmac_ciphertext: e.ciphertext,
  };
}

/**
 * The migration of one account as one batch on `g`: the new credential (version and `create` event) when
 * there is one, the `source` event, and the account update with the copied key. The caller built the grant
 * (the job grant, or a platform admin's resolution) and its checks; `revision` and every id stay as they are.
 */
export async function commitSource(
  ctx: ServiceContext,
  g: Grant,
  row: EnrolmentRow,
  legacy: Legacy | null,
  plan: Extract<Plan, { kind: 'existing' | 'create' }>,
  actor: { type: 'platform' | 'system'; id: string | null },
  after?: (g: Grant) => void,
): Promise<string> {
  let source: { id: string; identity: string };
  if (plan.kind === 'existing')
    source = { id: plan.credential.id, identity: plan.credential.identity_hash };
  else {
    const credentialId = ctx.ids.id();
    const versionId = ctx.ids.id();
    stageCredentialSave(
      g,
      ctx,
      { actor, platform: false },
      {
        credentialId,
        expectedRevision: 0,
        mode: row.mode,
        provider: row.provider,
        identityHash: plan.identityHash,
        identityHint: plan.hint,
        versionId,
        eventId: ctx.ids.id(),
        cardMap: plan.cardMap,
        envelope: await encryptSecret(
          await loadKekRing(ctx.env),
          JSON.stringify({
            version: 1,
            provider: plan.secret.provider,
            credentials: plan.secret.credentials,
          }),
          credentialAad(
            versionId,
            row.org_id,
            `wallet-credential:${credentialId}:org:${row.mode}:${row.provider}`,
          ),
        ),
      },
    );
    source = { id: credentialId, identity: plan.identityHash };
  }
  await commitEnrolmentStep(ctx, g, {
    accountId: row.id,
    isNew: false,
    provider: row.provider,
    expectedRevision: row.enrolment_revision,
    revision: row.enrolment_revision + 1,
    event: { id: ctx.ids.id(), kind: 'source', credentialId: source.id, actor },
    set: {
      credential_source_id: source.id,
      identity_hash: source.identity,
      enabled_at: null,
      ...(await keyColumns(ctx, row, legacy)),
    },
    ...(after ? { after } : {}),
  });
  return source.id;
}

export type MigrateOutcome = 'migrated' | 'skipped' | 'refused';

/** The `wallet.credential_migrate` job: one pending account onto its source. A rerun finds it done and skips. */
export async function runCredentialMigrate(
  ctx: ServiceContext,
  accountId: string,
): Promise<MigrateOutcome> {
  ctx = snapshotWalletCredentialContext(ctx);
  const legacyRow = await findPending(ctx.env.DB, accountId);
  if (!legacyRow) return 'skipped';
  const row = await findEnrolment(ctx.env.DB, legacyRow.org_id, legacyRow.mode, legacyRow.provider);
  if (!row || row.credential_source_id !== null || row.enrolment_revision !== 0) return 'skipped';
  const legacy = await openLegacy(ctx, legacyRow);
  const plan = await planSource(ctx, legacyRow, legacy.source);
  if (plan.kind === 'refused') {
    ctx.log.warn('wallet.credential_migrate_refused', {
      code: 'WALLET_MIGRATION_REFUSED',
      orgId: row.org_id,
      accountId: row.id,
      reason: plan.reason,
    });
    return 'refused';
  }
  const checks: Check[] = [accountAt(row.id, 'enrolment_revision', 0)];
  if (plan.kind === 'create')
    checks.push(noRivalCredential(row.org_id, row.mode, row.provider, plan.identityHash));
  const g = jobGrant(ctx, {
    purpose: 'org_mode.job.wallet.credential_migrate',
    job: 'wallet',
    orgId: row.org_id,
    mode: row.mode,
    inactiveOk: true,
    tables: [...CREDENTIAL_TABLES, ...ENROLMENT_TABLES],
    checks,
    codes: { config: 'WALLET_ACCOUNT_CONFLICT' },
  });
  await commitSource(ctx, g, row, legacy, plan, { type: 'system', id: null });
  return 'migrated';
}

/** Queues one job per pending account (platform admin). */
export async function queueMigration(ctx: ServiceContext, auth: PlatformCaller): Promise<number> {
  platformCaller(auth);
  let queued = 0;
  let after = '';
  for (;;) {
    const page = await pendingAccounts(ctx.env.DB, after, 100);
    if (page.length === 0) return queued;
    await ctx.env.JOBS.sendBatch(
      page.map((a) => ({ body: { kind: 'wallet.credential_migrate' as const, accountId: a.id } })),
    );
    queued += page.length;
    after = page[page.length - 1]?.id ?? '';
  }
}

const REPORT_PAGE = 100;

/** Pending accounts and why each waits; provider ids never leave. `identityShared` names the other accounts. */
export async function migrationReport(
  ctx: ServiceContext,
  auth: PlatformCaller,
  after = '',
): Promise<WalletMigrationReport> {
  platformCaller(auth);
  ctx = snapshotWalletCredentialContext(ctx);
  const counts = await countAccounts(ctx.env.DB);
  const page = await pendingAccounts(ctx.env.DB, after, REPORT_PAGE + 1);
  const next = page.length > REPORT_PAGE ? (page[REPORT_PAGE - 1]?.id ?? null) : null;
  const items: WalletMigrationReport['items'] = [];
  for (const a of page.slice(0, REPORT_PAGE)) {
    const base = { accountId: a.id, orgId: a.org_id, mode: a.mode, provider: a.provider };
    const row = await findPending(ctx.env.DB, a.id);
    let plan: Plan | null = null;
    if (row)
      try {
        plan = await planSource(ctx, a, (await openLegacy(ctx, row)).source);
      } catch (error) {
        ctx.log.warn('wallet.credential_migrate_unreadable', {
          code: 'WALLET_CREDENTIALS_UNAVAILABLE',
          accountId: a.id,
          d1: classifyD1Error(error)?.kind ?? null,
        });
      }
    items.push(
      plan === null
        ? { ...base, state: 'refused', reason: 'unreadable', identityShared: [] }
        : plan.kind === 'refused'
          ? { ...base, state: 'refused', reason: plan.reason, identityShared: plan.shared }
          : plan.kind === 'create' && plan.unproven.length > 0
            ? { ...base, state: 'ready', reason: 'unproven_claim', identityShared: plan.unproven }
            : { ...base, state: 'ready', reason: null, identityShared: [] },
    );
  }
  return { ...counts, items, next, nextCursor: next };
}
