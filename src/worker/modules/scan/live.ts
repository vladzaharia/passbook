import type { ScanOutcome } from '../../../shared/contracts/scan.ts';
import type { ScanLiveRow } from '../../../shared/contracts/scan-setups.ts';
import { ForbiddenError, UnauthenticatedError } from '../../platform/errors.ts';
import type { ServiceContext } from '../../platform/service-context.ts';
import type { ScanActor } from './guard.ts';
import type { LiveAttachment } from './live-auth.ts';
import { candidateById } from './repo-lookup.ts';
import { scanById } from './repo-scans.ts';

export const scanHub = (ctx: ServiceContext, orgId: string, mode: string) =>
  ctx.env.SCAN_HUB.getByName(`${orgId}:${mode}`);

export function liveAttachment(ctx: ServiceContext, actor: ScanActor): LiveAttachment {
  const row = actor.scanner;
  if (
    actor.terminal ||
    !row ||
    (actor.principal === 'scanner' ? !row.tokenHash : !actor.platformSessionId)
  )
    throw new UnauthenticatedError('Pair this screen to continue.', 'SCANNER_UNAUTHENTICATED');
  if (row.deviceRole === 'scan')
    throw new ForbiddenError('Choose a screen view in Scanning.', 'SCREEN_REQUIRED');
  return {
    orgId: actor.orgId,
    mode: actor.mode,
    scannerId: row.id,
    role: row.deviceRole,
    tokenHash: row.tokenHash ?? '',
    revision: row.updatedAt,
    expiresAt: Math.min(
      actor.principal === 'admin' ? Infinity : (row.expiresAt ?? 0),
      ctx.clock.now() + 15 * 60_000,
    ),
    ...(actor.principal === 'admin' && actor.platformSessionId
      ? { admin: { sessionId: actor.platformSessionId, userId: actor.actor.id } }
      : {}),
  };
}

export function publishScan(
  ctx: ServiceContext,
  actor: ScanActor,
  out: ScanOutcome,
  method: string,
  undo = false,
) {
  if (!actor.scanner || (!actor.scanningSession && !actor.scanner.hasScreens) || out.replay) return;
  const row: ScanLiveRow = {
    id: out.scanId ?? ctx.ids.ordered(),
    at: ctx.clock.now(),
    scannerId: actor.scanner.id,
    scannerName: actor.name,
    passId: out.card?.passId ?? null,
    holder: out.display?.identity.holder ?? null,
    photoUrl: null,
    kind: undo ? 'undo' : out.kind,
    direction: out.checkIn?.direction ?? (out.kind === 'ok' ? 'in' : null),
    label: undo
      ? 'Undone'
      : out.kind === 'ok'
        ? out.checkIn?.direction === 'out'
          ? 'Checked out'
          : 'Checked in'
        : out.kind === 'ready'
          ? 'Choose an action'
          : out.kind === 'heads_up'
            ? 'Check required'
            : 'Not accepted',
    presented: method !== 'manual',
  };
  ctx.waitUntil(
    (async () => {
      if (!row.passId && out.scanId)
        row.passId = (await scanById(ctx.env.DB, actor.orgId, out.scanId))?.passId ?? null;
      const candidate = row.passId
        ? await candidateById(ctx.env.DB, actor.orgId, row.passId)
        : null;
      row.passId = candidate?.pass.mode === actor.mode ? candidate.pass.id : null;
      row.holder =
        candidate?.pass.mode === actor.mode
          ? (candidate.pass.displayTitle ?? '').slice(0, 40)
          : null;
      const accepted = await scanHub(ctx, actor.orgId, actor.mode).publish({
        orgId: actor.orgId,
        mode: actor.mode,
        row,
      });
      if (!accepted) throw new Error('SCAN_LIVE_PUBLISH_REJECTED');
    })().catch((error) => {
      ctx.log.error('scan.live_publish_failed', {
        orgId: actor.orgId,
        code: 'SCAN_LIVE_PUBLISH_FAILED',
        error,
      });
    }),
  );
}

/** A failed kick is retried and reported; the receiver also checks rows before any delivery. */
export async function kickScreen(ctx: ServiceContext, orgId: string, mode: string, id: string) {
  try {
    const closed = await scanHub(ctx, orgId, mode).kick(id);
    ctx.log.info('scan.live_kicked', { orgId, scannerId: id, closed });
  } catch (error) {
    ctx.log.warn('scan.live_kick_retry', { orgId, code: 'SCAN_LIVE_KICK_RETRY', error });
    await scanHub(ctx, orgId, mode).kick(id);
  }
}
