import type {
  PlatformWalletEnrolmentList,
  WalletProvider,
} from '../../../shared/contracts/wallet-providers.ts';
import type { SessionAuth } from '../../platform/auth.ts';
import { ForbiddenError } from '../../platform/errors.ts';
import type { ServiceContext } from '../../platform/service-context.ts';
import { platformEnrolmentRows } from './repo-enrolments-platform.ts';

/** Every org's enrolment of one provider, both modes. */
export async function listPlatformEnrolments(
  ctx: ServiceContext,
  auth: SessionAuth,
  provider: WalletProvider,
): Promise<PlatformWalletEnrolmentList> {
  if (auth?.kind !== 'session' || !auth.roles.includes('admin'))
    throw new ForbiddenError('Admin access is required.');
  const rows = await platformEnrolmentRows(ctx.env.DB, provider);
  return {
    items: rows.map((r) => ({
      orgId: r.org_id,
      orgName: r.org_name,
      mode: r.mode,
      provider: r.provider,
      source: r.source_scope,
      state:
        r.revoked_at !== null
          ? 'revoked'
          : r.platform_hold_at !== null
            ? 'held'
            : r.enabled_at !== null
              ? 'on'
              : 'off',
      hold:
        r.platform_hold_at !== null
          ? { at: r.platform_hold_at, reason: r.platform_hold_reason ?? '' }
          : null,
      updatedAt: r.updated_at,
    })),
  };
}
