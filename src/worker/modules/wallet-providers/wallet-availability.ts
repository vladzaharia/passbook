import type { ServiceContext } from '../../platform/service-context.ts';
import { walletProviderIssuance } from './provider-policy.ts';
import { type EnrolmentRow, enrolmentsOf } from './repo-enrolments.ts';

type Mode = 'live' | 'test';
type Provider = 'google' | 'samsung';

export function enrolmentState(row: EnrolmentRow | null) {
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
