import type { ScanRole } from '../../../shared/contracts/scan.ts';
import { UnauthenticatedError } from '../../platform/errors.ts';
import type { ServiceContext } from '../../platform/service-context.ts';
import type { ScanActor } from './actor.ts';
import { snapshotCredentialEnv } from './credential-input.ts';
import {
  createHistoryEvidenceCache,
  historyEvidenceOf,
  withKeyset,
} from './history-row-evidence.ts';
import { readHistoryPage } from './repo-history-rows.ts';
import {
  SESSION_READ,
  scanAuthorizedStmt,
  scanReadAuthority,
  withSessionRow,
} from './repo-read-authority.ts';
import type { ScanningSessionRow } from './repo-scanning-sessions.ts';
import { activitySelector } from './repo-session-activity.ts';
import { resolveSessionScope, type SessionReadAuthority } from './scanning-session-dto.ts';
import { scanSessionCountAuthority } from './scanning-workspace.ts';
import {
  captureObservedScanningSession,
  cloneObservedScanActor,
} from './scanning-workspace-observation.ts';
import { staleScanRead } from './stale-read.ts';

/**
 * The session's recent scans from one snapshot under the viewer's fence and the session row as it
 * was read. A row shows its pass, title, device name and direction only when its signed policy and
 * the pass in that snapshot allow it to this role. Null when the fence no longer holds.
 */
export async function scanningSessionActivity(
  context: ServiceContext,
  row: ScanningSessionRow,
  authority: SessionReadAuthority,
  role: ScanRole,
) {
  if (
    !authority ||
    authority.orgId !== row.org_id ||
    authority.mode !== row.mode ||
    (authority.sessionId !== undefined && authority.sessionId !== row.id) ||
    (role !== 'door' && role !== 'desk' && role !== 'manager')
  )
    return null;
  const ctx = { ...context, env: snapshotCredentialEnv(context.env) };
  if (!(await resolveSessionScope(ctx, row)).valid) return null;
  const selector = activitySelector(row);
  if (!selector) return null;
  const now = ctx.clock.now();
  const auth = withSessionRow(authority.at(now), row);
  const page = await readHistoryPage(
    ctx.env.DB,
    auth,
    { ...selector, tenant: auth.tenant('+s', 'scans') },
    now,
  );
  if (!page.authorized) return null;
  const evidence = await withKeyset(ctx, page.rows, () =>
    historyEvidenceOf(ctx, page.rows, {
      role,
      cache: createHistoryEvidenceCache(),
      requireAvailable: false,
    }),
  );
  return page.rows.map((scan) => {
    const found = evidence.get(scan.id);
    const policy = found?.policy ?? null;
    const name = scan.scannerName ?? '';
    const title = found?.sources.currentTitle ?? null;
    return {
      id: scan.id,
      at: scan.at,
      deviceId: scan.raw.raw_scanner_id ?? '',
      deviceName: policy?.scannerNameVisible(name) ? name : 'Scanner',
      passId: policy ? scan.passId : null,
      title: policy?.titleVisible(title) ? title : null,
      outcome: scan.raw.raw_undone_by !== null ? ('undone' as const) : (scan.outcome ?? 'refused'),
      direction:
        policy && policy.action(scan.actionId, scan.actionKind) !== null ? scan.direction : null,
    };
  });
}

/** Device activity under the device's own fence; an invalid scope is configuration, not credential. */
export async function sessionActivityFor(context: ServiceContext, sourceActor: ScanActor) {
  const ctx = { ...context, env: snapshotCredentialEnv(context.env) };
  const actor = cloneObservedScanActor(sourceActor);
  const observed = actor.scanningSession ? captureObservedScanningSession(actor) : null;
  if (!actor.role || (actor.scanningSession && !observed))
    throw new UnauthenticatedError('Pair this scanner to continue.', 'SCANNER_UNAUTHENTICATED');
  // The device stays paired and sees no activity for an invalid scope, or when it has no session.
  if (actor.invalidScannerScope || !observed) {
    const auth = scanReadAuthority(actor, { now: ctx.clock.now(), read: SESSION_READ });
    const status = await scanAuthorizedStmt(ctx.env.DB, auth).first<{ authorized: number }>();
    if (status?.authorized === 1) return { items: [] };
    throw await staleScanRead(ctx, sourceActor);
  }
  const rows = await scanningSessionActivity(
    ctx,
    observed.parent,
    scanSessionCountAuthority(actor),
    actor.role,
  );
  if (rows === null) throw await staleScanRead(ctx, sourceActor);
  return {
    items: rows.filter((item) => actor.settings.lookup || item.deviceId === actor.scanner?.id),
  };
}
