import { beforeEach } from 'vitest';
import { makeSession, makeUser } from '../../../../test/helpers/index.ts';
import { first, run } from '../../platform/db.ts';
import { createSessionStore } from '../auth/sessions.ts';
import { ensureCredentialRefKeyset } from '../passes/credential-keyset.ts';
import { tenantAuthorityOf } from '../passes/http.ts';
import {
  adminActor,
  captureScanTenantAuthority,
  denyInvalidScannerScope,
  type ScanActor,
  scannerActor,
  tenantScanRole,
  withRole,
} from './actor.ts';
import { actorCsrfFence } from './actor-csrf.ts';
import { actorAuthorityCurrent } from './repo-actor-authority.ts';
import { getScanner, unbindStaff } from './repo-device.ts';
import { uniqueScanEventIdSql } from './repo-history-provenance.ts';
import { readScannerScope, type ScanEventRow } from './repo-scope.ts';
import {
  minimalHistoryAuthorityPredicate,
  sessionReadAuthorityCurrent,
} from './repo-session-authority.ts';
import { bindScanningSession } from './scanning-workspace.ts';
import { boundStaff } from './staff-binding.ts';
import { grantScanMembership, proofedScanActor, type ScanKit, setupScanKit } from './test-kit.ts';

export const CHECK_IN = { id: 'check_in', label: 'Check in', kind: 'check_in' } as const;
export let kit: ScanKit;

export function registerSessionAuthorityFixture() {
  beforeEach(async () => {
    kit = await setupScanKit();
    await ensureCredentialRefKeyset(kit.env.DB, kit.env);
  });
}

/** Follow the same snapshot and deliberate-unbind path as the session guard. */
export async function scannerSnapshot(id: string): Promise<ScanActor> {
  const row = await getScanner(kit.env.DB, id);
  if (!row) throw new Error('Missing scanner.');
  const scope = await readScannerScope(kit.env.DB, row, row.staffId);
  const actor = scannerActor(
    kit.ctx,
    row,
    row.mode,
    row.kind === 'terminal' ? 'bearer' : 'cookie',
    scope,
  );
  withRole(actor, actor.terminal ? null : await boundStaff(kit.ctx, row, scope.staff));
  await bindScanningSession(kit.ctx, actor);
  denyInvalidScannerScope(actor);
  if (!actor.settings.staffSignIn && row.staffId) {
    const previous = actor.scanningSession;
    const revision = row.updatedAt;
    await unbindStaff(kit.env.DB, row);
    if (row.updatedAt !== revision) {
      actor.staff = null;
      delete actor.scanningSession;
      await bindScanningSession(kit.ctx, actor);
      const refreshed = (actor as ScanActor).scanningSession;
      if (
        previous?.id !== refreshed?.id ||
        previous?.status !== refreshed?.status ||
        previous?.updatedAt !== refreshed?.updatedAt
      )
        throw new Error('Session changed during unbind.');
      denyInvalidScannerScope(actor);
    }
  }
  return proofedScanActor(
    kit.ctx,
    withRole(actor, actor.settings.staffSignIn ? actor.staff : null),
  );
}

export async function adminSnapshot() {
  const user = await makeUser(kit.fx);
  const membershipId = await grantScanMembership(kit.fx, kit.org.id, user.id);
  const session = await makeSession(kit.fx, { userId: user.id, roles: ['user'] });
  const auth = await createSessionStore(kit.env, kit.clock).resolve(session.cookieValue);
  if (!auth) throw new Error('Missing admin session.');
  const authority = await tenantAuthorityOf(kit.ctx, auth, kit.org.id, 'scanning:read');
  if (authority.kind !== 'session') throw new Error('Expected tenant session authority.');
  const actor = adminActor(auth, 'live', {
    orgId: kit.org.id,
    event: null,
    templateIds: [],
    timeZone: 'UTC',
  });
  actor.platformSessionId = auth.sessionId;
  actor.tenantAuthority = await captureScanTenantAuthority(kit.ctx, auth, authority);
  actor.role = tenantScanRole(authority);
  return { actor, auth, user, membershipId, sessionId: auth.sessionId };
}

export async function attachSession(
  scannerId: string,
  options: {
    status?: 'active' | 'paused' | 'ended';
    accepts?: string | null;
  } = {},
) {
  const id = kit.fx.ids.id();
  const now = kit.clock.now();
  await run(
    kit.env.DB,
    `INSERT INTO scanning_sessions
    (id,org_id,mode,name,status,accepts,settings,time_zone,created_at,updated_at)
    SELECT ?,org_id,mode,'Session',?,?,settings,time_zone,?,? FROM scanners WHERE id=?`,
    [id, options.status ?? 'active', options.accepts ?? null, now, now, scannerId],
  );
  await run(
    kit.env.DB,
    `INSERT INTO scanning_devices
    (scanner_id,session_id,org_id,mode,surface,effective_surface,overrides)
    SELECT id,?,org_id,mode,'phone','phone','{}' FROM scanners WHERE id=?`,
    [id, scannerId],
  );
  return id;
}

export const current = (actor: ScanActor) =>
  sessionReadAuthorityCurrent(kit.ctx, actor, kit.clock.now());
export const strict = (actor: ScanActor) =>
  actorAuthorityCurrent(kit.env.DB, {
    actor,
    now: kit.clock.now(),
    event: actor.event,
    adminEventTemplates: actor.adminEventTemplates === true,
  });

export async function receiptCurrent(
  actor: ScanActor,
  scanId: string,
  events: readonly ScanEventRow[],
) {
  const csrf = await actorCsrfFence(kit.ctx, actor);
  if (!csrf) return false;
  const predicate = minimalHistoryAuthorityPredicate(actor, kit.clock.now(), {
    scanAlias: 'q',
    ledgerAlias: 'l',
    events,
  });
  const row = await first<{ ok: number }>(
    kit.env.DB,
    `SELECT 1 AS ok FROM scans q
    LEFT JOIN pass_events l ON l.id=${uniqueScanEventIdSql('q')}
    WHERE q.id=? AND q.state='done' AND (${predicate.sql}) AND (${csrf.sql})`,
    [scanId, ...predicate.params, ...csrf.params],
  );
  return row?.ok === 1;
}
