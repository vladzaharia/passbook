import type {
  PlatformWalletEnrolmentList,
  WalletProvider,
} from '../../../shared/contracts/wallet-providers.ts';
import { ForbiddenError, ValidationError } from '../../platform/errors.ts';
import type { ServiceContext } from '../../platform/service-context.ts';
import { isActor, type WalletPlatformCaller } from './platform-caller.ts';
import { type EnrolmentCursor, platformEnrolmentRows } from './repo-enrolments-platform.ts';

function decodeCursor(raw: string | undefined): EnrolmentCursor | undefined {
  if (!raw) return undefined;
  try {
    const v: unknown = JSON.parse(atob(raw));
    if (Array.isArray(v) && v.length === 3 && v.every((x) => typeof x === 'string'))
      return v as EnrolmentCursor;
  } catch {
    // Falls through to the validation error below.
  }
  throw new ValidationError('The cursor is not valid.');
}

/** Every org's enrolment of one provider, both modes. */
export async function listPlatformEnrolments(
  ctx: ServiceContext,
  auth: WalletPlatformCaller,
  provider: WalletProvider,
  limit = 50,
  rawCursor?: string,
): Promise<PlatformWalletEnrolmentList> {
  if (!isActor(auth) && (auth?.kind !== 'session' || !auth.roles.includes('admin')))
    throw new ForbiddenError('Admin access is required.');
  const cursor = decodeCursor(rawCursor);
  const fetched = await platformEnrolmentRows(ctx.env.DB, provider, limit + 1, cursor);
  const rows = fetched.slice(0, limit);
  const last = rows.at(-1);
  return {
    nextCursor:
      fetched.length > limit && last
        ? btoa(JSON.stringify([last.org_name, last.org_id, last.mode]))
        : null,
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
