import type {
  WalletEnrolment,
  WalletEnrolmentList,
} from '../../../shared/contracts/wallet-providers.ts';
import type { SessionAuth } from '../../platform/auth.ts';
import { ForbiddenError } from '../../platform/errors.ts';
import type { ServiceContext } from '../../platform/service-context.ts';
import { tenantAuthorityOf } from '../passes/http.ts';
import { walletProviderIssuance } from './provider-policy.ts';
import { credentialById, findActiveCredential } from './repo-credentials.ts';
import { type EnrolmentRow, enrolmentsOf, freshCheckId, testRoundTrip } from './repo-enrolments.ts';

type Mode = 'live' | 'test';
type Provider = 'google' | 'samsung';
const PROVIDERS: Provider[] = ['google', 'samsung'];

function sessionOf(auth: SessionAuth): SessionAuth {
  if (auth?.kind !== 'session') throw new ForbiddenError();
  return auth;
}

function enrolmentState(row: EnrolmentRow | null) {
  return !row?.credential_source_id && row?.revoked_at == null
    ? 'absent'
    : row?.revoked_at != null
      ? 'revoked'
      : row?.platform_hold_at != null
        ? 'held'
        : row?.enabled_at != null
          ? 'on'
          : 'off';
}

/**
 * Whether a wallet is open for the org in a mode, for the template release rows: `not_released` while the
 * platform has not opened the wallet, `on` when the org has it enabled, else `off`. No credential or
 * enrolment detail leaves here, so it needs no integrations permission; the caller checks the review capability.
 */
export async function walletAvailability(
  ctx: ServiceContext,
  orgId: string,
  mode: Mode,
  provider: Provider,
): Promise<'on' | 'off' | 'not_released'> {
  if (walletProviderIssuance(provider, mode).state !== 'enabled') return 'not_released';
  const row = (await enrolmentsOf(ctx.env.DB, orgId, mode)).find((r) => r.provider === provider);
  return enrolmentState(row ?? null) === 'on' ? 'on' : 'off';
}

export async function enrolmentView(
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
  const state = enrolmentState(row);
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
    issuance: walletProviderIssuance(provider, mode),
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
  return { items, nextCursor: null };
}
