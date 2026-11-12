import { first } from '../../platform/db.ts';
import type { TenantPassWrite } from './http.ts';
import { tenantPassAuthorityParams, tenantPassAuthoritySql } from './repo-authority.ts';
import {
  type RefreshSnapshot,
  refreshParams,
  refreshPredicate,
  validRefreshEpochs,
} from './repo-refresh-snapshot.ts';

export {
  type ConnectionPassContext,
  validConnectionPassContext,
} from './repo-connection-context.ts';
export { applyConnectionState } from './repo-connection-state.ts';
export * from './repo-map.ts';
export { claimRefresh, setDownloadToken, softDeletePass } from './repo-pass-trusted.ts';
export type { RefreshSnapshot } from './repo-refresh-snapshot.ts';

function permitsTenantPassMutation(authority: TenantPassWrite): boolean {
  return authority.kind === 'session'
    ? authority.capability === 'passes:operate'
    : authority.scopes.includes('passes:write');
}

/** Recheck authority as well as the snapshot before treating a failed claim as coalesced. */
export async function matchesRefreshSnapshot(
  db: D1Database,
  snapshot: RefreshSnapshot,
  authority?: TenantPassWrite,
  now?: number,
): Promise<boolean> {
  if (
    !validRefreshEpochs(snapshot) ||
    (authority && (now === undefined || !permitsTenantPassMutation(authority)))
  )
    return false;
  const row = await first<{ id: string }>(
    db,
    `SELECT id FROM passes WHERE id = ? AND ${refreshPredicate}
      ${authority ? `AND mode = ? AND ${tenantPassAuthoritySql(authority, 'passes')}` : ''}`,
    [
      snapshot.passId,
      ...refreshParams(snapshot),
      ...(authority && now !== undefined
        ? [authority.mode, ...tenantPassAuthorityParams(authority, now)]
        : []),
    ],
  );
  return row !== null;
}

export * from './repo-devices.ts';
export * from './repo-history.ts';
export * from './repo-list.ts';
export * from './repo-ops.ts';
export * from './repo-write.ts';
