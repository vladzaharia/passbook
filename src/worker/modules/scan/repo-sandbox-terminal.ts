import { SANDBOX_TEMPLATE_NAME, SANDBOX_TERMINAL_NAME } from '../../../shared/copy/developer.ts';
import { DEFAULT_TIME_ZONE } from '../../../shared/time-zone.ts';
import type { ApiKeyAuth, SessionAuth } from '../../platform/auth.ts';
import { grant } from '../../platform/authority.ts';
import { first } from '../../platform/db.ts';
import type { ServiceContext } from '../../platform/service-context.ts';
import { type TenantPassWrite, tenantAuthorityOf } from '../passes/http.ts';
import { capabilityChecks, tenantPrincipal } from '../passes/repo-authority.ts';
import { DEFAULT_SETTINGS } from './dto-console.ts';
import { TERMINAL_TTL_MS } from './pairing-token.ts';
import {
  audited,
  createdByOf,
  modeFreeAuthorityOf,
  type ScanPurpose,
  templatesUsable,
} from './repo-admin-grant.ts';
import { addScannerTemplates } from './repo-admin-unguarded.ts';
import { orgAccessRevisionOf } from './repo-api-key.ts';
import { addScannerInsert, addScannerRevoke } from './repo-scanners.ts';
import { SCANNER_CODES } from './scanners.ts';

const PURPOSE: ScanPurpose = 'org_mode.scan.scanner.create';
const TERMINAL_TABLES = ['scanners', 'scanner_templates', 'developer_sandboxes'];

const LOG_WINDOW_MS = 60_000;
const MAX_TRACKED = 1000;
const lastFailure = new Map<string, number>();

type Held = { id: string; expires_at: number | null };

const heldTerminal = (db: D1Database, orgId: string) =>
  first<Held>(
    db,
    `SELECT s.id, s.expires_at FROM scanners s
     WHERE s.org_id = ? AND s.mode = 'test' AND s.kind = 'terminal' AND s.name = ? AND s.revoked_at IS NULL`,
    [orgId, SANDBOX_TERMINAL_NAME],
  );

/** The authority of the caller: a console session by membership, or the sandbox key under its own scope. */
async function authorityOf(
  ctx: ServiceContext,
  caller: SessionAuth | ApiKeyAuth,
  orgId: string,
): Promise<{ authority: TenantPassWrite; actorId: string } | null> {
  if (caller.kind === 'session')
    return {
      authority: await tenantAuthorityOf(ctx, caller, orgId, 'scanning:manage'),
      actorId: caller.userId,
    };
  const revision = await orgAccessRevisionOf(ctx.env.DB, orgId);
  if (caller.orgId !== orgId || revision === null || !caller.scopes.includes('scanning:write'))
    return null;
  return {
    authority: {
      kind: 'api_key',
      orgId,
      orgAccessRevision: revision,
      keyId: caller.keyId,
      keyOrgId: caller.orgId,
      scopes: [...caller.scopes],
      scope: 'scanning:write',
      mode: 'test',
    },
    actorId: caller.keyId,
  };
}

/**
 * The sandbox's one terminal: Test only, accepts the Quickstart ticket, never paired. The sandbox key scans as it
 * (`keyActsAsTerminalSql`). Made like any scanner, minus the `scanning.devices` quota (a sandbox's is 0: this is
 * the sandbox's own fixture, not a device the person made). Idempotent: a live one is kept, an expired one is
 * replaced in the same grant, and a lost race adopts the winner. A failure is logged and the sandbox stays usable.
 * `developer_sandboxes.terminal_id` names it.
 */
export async function ensureSandboxTerminal(
  ctx: ServiceContext,
  caller: SessionAuth | ApiKeyAuth,
  orgId: string,
): Promise<void> {
  const db = ctx.env.DB;
  const now = ctx.clock.now();
  try {
    const open = await first<{ terminal_id: string | null }>(
      db,
      'SELECT terminal_id FROM developer_sandboxes WHERE org_id = ? AND closed_at IS NULL',
      [orgId],
    );
    if (!open) return;
    const held = await heldTerminal(db, orgId);
    if (held && held.id === open.terminal_id && (held.expires_at === null || held.expires_at > now))
      return;
    const templateId =
      (
        await first<{ id: string }>(db, 'SELECT id FROM templates WHERE org_id = ? AND name = ?', [
          orgId,
          SANDBOX_TEMPLATE_NAME,
        ])
      )?.id ?? null;
    const who = await authorityOf(ctx, caller, orgId);
    if (templateId === null || who === null) {
      ctx.log.warn('developer.sandbox_terminal_skipped', {
        orgId,
        code: templateId === null ? 'SANDBOX_TEMPLATE_MISSING' : 'SANDBOX_KEY_SCOPE_MISSING',
      });
      return;
    }
    const { authority, actorId } = who;
    const id = ctx.ids.id();
    // Per mode, never live-only: the grant is built without the live-only refusals (they cannot occur here).
    const admin = modeFreeAuthorityOf(authority, actorId, orgId, PURPOSE);
    const g = grant(ctx, {
      purpose: PURPOSE,
      principal: tenantPrincipal(admin),
      checks: [...capabilityChecks(admin), ...templatesUsable([templateId])],
      tables: TERMINAL_TABLES,
      codes: SCANNER_CODES,
      target: id,
    });
    // One that is expired (or not the one the sandbox names) still holds the name: it goes in the same grant.
    if (held) addScannerRevoke(g, held.id, now);
    addScannerInsert(g, {
      id,
      kind: 'terminal',
      name: SANDBOX_TERMINAL_NAME,
      eventId: null,
      settings: JSON.stringify(DEFAULT_SETTINGS),
      timeZone: DEFAULT_TIME_ZONE,
      expiresAt: now + TERMINAL_TTL_MS,
      createdBy: createdByOf(authority, actorId),
      now,
    });
    addScannerTemplates(g, id, [templateId]);
    g.update('developer_sandboxes', {
      set: { terminal_id: id },
      where: { closed_at: null },
    });
    g.add(
      audited(g, ctx, {
        orgId,
        actorType: authority.kind === 'api_key' ? 'api_key' : 'user',
        actorId,
        action: 'scanner.create',
        targetType: 'scanner',
        targetId: id,
        detail: { kind: 'terminal', mode: 'test', accepts: 'templates' },
      }),
    );
    try {
      await g.commit();
    } catch (error) {
      // A racing call made it first: theirs stands.
      const winner = await heldTerminal(db, orgId);
      if (!winner || winner.id === held?.id) throw error;
    }
  } catch (error) {
    // A grant that keeps failing is logged once per caller and window, not on every call.
    const who = caller.kind === 'api_key' ? caller.keyId : orgId;
    if (now - (lastFailure.get(who) ?? -LOG_WINDOW_MS) >= LOG_WINDOW_MS) {
      for (const [k, at] of lastFailure) if (now - at >= LOG_WINDOW_MS) lastFailure.delete(k);
      if (lastFailure.size >= MAX_TRACKED) lastFailure.clear();
      lastFailure.set(who, now);
      ctx.log.error('developer.sandbox_terminal_failed', {
        orgId,
        code: 'SANDBOX_TERMINAL_FAILED',
        error,
      });
    }
  }
}
