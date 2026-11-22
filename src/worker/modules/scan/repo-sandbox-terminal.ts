import { SANDBOX_TEMPLATE_NAME, SANDBOX_TERMINAL_NAME } from '../../../shared/copy/developer.ts';
import type { ApiKeyAuth, SessionAuth } from '../../platform/auth.ts';
import { first, run } from '../../platform/db.ts';
import type { ServiceContext } from '../../platform/service-context.ts';
import { type TenantPassWrite, tenantAuthorityOf } from '../passes/http.ts';
import { DEFAULT_SETTINGS } from './dto-console.ts';
import { TERMINAL_TTL_MS } from './pairing-token.ts';
import { adminGrant, audited, createdByOf, templatesUsable } from './repo-admin-grant.ts';
import { addScannerTemplates } from './repo-admin-unguarded.ts';
import { orgAccessRevisionOf } from './repo-api-key.ts';
import { addScannerInsert, addScannerRevoke } from './repo-scanners.ts';
import { SCANNER_CODES } from './scanners.ts';

type Held = { id: string; expires_at: number | null };

const heldTerminal = (db: D1Database, orgId: string) =>
  first<Held>(
    db,
    `SELECT s.id, s.expires_at FROM scanners s
     WHERE s.org_id = ? AND s.mode = 'test' AND s.kind = 'terminal' AND s.name = ? AND s.revoked_at IS NULL`,
    [orgId, SANDBOX_TERMINAL_NAME],
  );

const pin = (db: D1Database, orgId: string, id: string) =>
  run(
    db,
    'UPDATE developer_sandboxes SET terminal_id = ? WHERE org_id = ? AND terminal_id IS NOT ?',
    [id, orgId, id],
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
    const open = await first<{ ok: number }>(
      db,
      'SELECT 1 AS ok FROM developer_sandboxes WHERE org_id = ? AND closed_at IS NULL',
      [orgId],
    );
    if (!open) return;
    const held = await heldTerminal(db, orgId);
    if (held && (held.expires_at === null || held.expires_at > now)) {
      await pin(db, orgId, held.id);
      return;
    }
    const templateId =
      (
        await first<{ id: string }>(db, 'SELECT id FROM templates WHERE org_id = ? AND name = ?', [
          orgId,
          SANDBOX_TEMPLATE_NAME,
        ])
      )?.id ?? null;
    const who = await authorityOf(ctx, caller, orgId);
    if (templateId === null || who === null) return;
    const { authority, actorId } = who;
    const id = ctx.ids.id();
    const g = adminGrant(
      ctx,
      'org_mode.scan.scanner.create',
      actorId,
      authority,
      orgId,
      [...templatesUsable([templateId])],
      SCANNER_CODES,
      id,
    );
    // An expired terminal still holds the name: it goes in the same grant that makes the new one.
    if (held) addScannerRevoke(g, held.id, now);
    addScannerInsert(g, {
      id,
      kind: 'terminal',
      name: SANDBOX_TERMINAL_NAME,
      eventId: null,
      settings: JSON.stringify(DEFAULT_SETTINGS),
      timeZone: 'UTC',
      expiresAt: now + TERMINAL_TTL_MS,
      createdBy: createdByOf(authority, actorId),
      now,
    });
    addScannerTemplates(g, id, [templateId]);
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
      // A racing call made it first: use theirs.
      const winner = await heldTerminal(db, orgId);
      if (!winner || winner.id === held?.id) throw error;
      await pin(db, orgId, winner.id);
      return;
    }
    await pin(db, orgId, id);
  } catch (error) {
    ctx.log.error('developer.sandbox_terminal_failed', {
      orgId,
      code: 'SANDBOX_TERMINAL_FAILED',
      error,
    });
  }
}
