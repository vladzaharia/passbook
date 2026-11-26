import { sha256Hex } from '../../../platform/ids.ts';
import type { ServiceContext } from '../../../platform/service-context.ts';
import { type PlatformRow, platformByHash } from './repo-platform.ts';
import type { InviteState } from './resolve.ts';

export interface PlatformInvite {
  row: PlatformRow;
  state: InviteState;
  /** Past `expires_at` but inside the claim window: it may be finished, not started again. */
  late: boolean;
  groups: string[];
  developer: boolean;
}

export function platformInviteOf(row: PlatformRow, now: number): PlatformInvite | null {
  let groups: unknown;
  try {
    groups = JSON.parse(row.groups);
  } catch {
    return null;
  }
  if (!Array.isArray(groups) || !groups.every((g): g is string => typeof g === 'string'))
    return null;
  const state: InviteState =
    row.accepted_at !== null
      ? 'accepted'
      : row.revoked_at !== null
        ? 'revoked'
        : now >= row.claim_until
          ? 'expired'
          : 'pending';
  return {
    row,
    state,
    late: state === 'pending' && now >= row.expires_at,
    groups,
    developer: row.developer === 1,
  };
}

/** The platform invitation a `p_` secret names, or null. */
export async function resolvePlatform(
  ctx: ServiceContext,
  secret: string,
): Promise<PlatformInvite | null> {
  const row = await platformByHash(ctx.env.DB, await sha256Hex(secret));
  return row ? platformInviteOf(row, ctx.clock.now()) : null;
}
