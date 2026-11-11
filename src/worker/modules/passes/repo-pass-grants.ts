import { type Check, rowIs } from '../../platform/authority-checks.ts';
import { lte, orNull } from '../../platform/authority-expr.ts';
import type { ServiceContext } from '../../platform/service-context.ts';
import type { TenantPassWrite } from './http.ts';
import type { Pass } from './repo-map.ts';
import {
  commitRows,
  noPendingTransfer,
  passWriteGrant,
  permitsPassWrite,
  tenantPassGrant,
} from './repo-pass-grant.ts';
import { type RefreshSnapshot, validRefreshEpochs } from './repo-refresh-snapshot.ts';

/** Tenant soft delete: unlinks the pass from its owner and connection. */
export async function softDeletePassGranted(
  ctx: ServiceContext,
  pass: Pass,
  authority: TenantPassWrite,
): Promise<boolean> {
  if (!permitsPassWrite(authority)) return false;
  const g = passWriteGrant(ctx, 'org_mode.pass.delete', authority, pass);
  g.update('passes', {
    set: {
      deleted_at: ctx.clock.now(),
      owner_user_id: null,
      connection_id: null,
      external_ref: null,
      next_sync_at: null,
    },
    where: { id: pass.id, deleted_at: null },
    returning: ['id'],
  });
  return ((await commitRows(g)) ?? []).length === 1;
}

/** Tenant link rotation: a new download token invalidates every earlier link. */
export async function setDownloadTokenGranted(
  ctx: ServiceContext,
  pass: Pass,
  token: string,
  authority: TenantPassWrite,
): Promise<boolean> {
  if (!permitsPassWrite(authority)) return false;
  const g = passWriteGrant(ctx, 'org_mode.pass.rotate_link', authority, pass);
  g.update('passes', {
    set: { download_token: token, download_token_rotated_at: ctx.clock.now() },
    inc: ['link_generation'],
    where: { id: pass.id, deleted_at: null },
    returning: ['id'],
  });
  return ((await commitRows(g)) ?? []).length === 1;
}

/** Tenant refresh request: claims the cooldown slot against the snapshot the job will carry. */
export async function claimRefreshGranted(
  ctx: ServiceContext,
  snapshot: RefreshSnapshot,
  windowMs: number,
  authority: TenantPassWrite,
): Promise<boolean> {
  if (!permitsPassWrite(authority) || !validRefreshEpochs(snapshot)) return false;
  const now = ctx.clock.now();
  const checks: Check[] = [
    rowIs(
      'passes',
      snapshot.passId,
      {
        status: snapshot.status,
        version: snapshot.passVersion,
        connection_id: snapshot.connectionId,
        external_ref: snapshot.externalRef,
        owner_user_id: snapshot.ownerUserId,
        link_generation: snapshot.linkGeneration,
        identity_id: snapshot.identityId,
        credential_generation: snapshot.credentialGeneration,
        lifecycle_generation: snapshot.lifecycleGeneration,
        template_id: snapshot.templateId,
        template_version: snapshot.templateVersion,
        release_id: snapshot.releaseId,
        deleted_at: null,
        removed_at: null,
        test_data_quarantined: 0,
      },
      'lineage',
    ),
    noPendingTransfer(snapshot.passId),
  ];
  if (snapshot.connectionId !== null) {
    if (snapshot.mode !== 'live' || snapshot.status !== 'active') return false;
    checks.push(
      rowIs(
        'connections',
        snapshot.connectionId,
        { enabled: 1, generation: snapshot.generation, mode: snapshot.connectionMode },
        'lineage',
      ),
    );
  }
  const g = tenantPassGrant(ctx, 'org_mode.pass.refresh', authority, snapshot.passId, checks);
  g.update('passes', {
    set: { refresh_requested_at: now },
    where: { id: snapshot.passId, refresh_requested_at: orNull(lte(now - windowMs)) },
    returning: ['id'],
  });
  return ((await commitRows(g)) ?? []).length === 1;
}
