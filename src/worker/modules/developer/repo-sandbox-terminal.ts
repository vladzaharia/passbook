import { SANDBOX_TERMINAL_NAME } from '../../../shared/copy/developer.ts';
import type { SessionAuth } from '../../platform/auth.ts';
import { first } from '../../platform/db.ts';
import type { ServiceContext } from '../../platform/service-context.ts';
import { tenantAuthorityOf } from '../passes/http.ts';
import { DEFAULT_SETTINGS } from '../scan/dto-console.ts';
import { TERMINAL_TTL_MS } from '../scan/pairing-token.ts';
import { adminGrant, audited, templatesUsable } from '../scan/repo-admin-grant.ts';
import { addScannerTemplates } from '../scan/repo-admin-unguarded.ts';
import { addScannerInsert } from '../scan/repo-scanners.ts';
import { SCANNER_CODES } from '../scan/scanners.ts';

/**
 * The sandbox's one terminal: Test only, accepts the Quickstart ticket, never paired. The sandbox key scans as it
 * (`keyActsAsTerminalSql`). Made like any scanner, minus the `scanning.devices` quota (a sandbox's is 0: this is
 * the sandbox's own fixture, not a device the person made). A retry finds it made; a failure is logged and the
 * sandbox stays usable.
 */
export async function ensureSandboxTerminal(
  ctx: ServiceContext,
  test: SessionAuth,
  orgId: string,
  templateId: string | null,
): Promise<void> {
  if (templateId === null) return;
  const now = ctx.clock.now();
  const live = await first<{ ok: number }>(
    ctx.env.DB,
    `SELECT 1 AS ok FROM scanners WHERE org_id = ? AND mode = 'test' AND name = ? AND revoked_at IS NULL
       AND (expires_at IS NULL OR expires_at > ?)`,
    [orgId, SANDBOX_TERMINAL_NAME, now],
  );
  if (live) return;
  try {
    const authority = await tenantAuthorityOf(ctx, test, orgId, 'scanning:manage');
    const id = ctx.ids.id();
    const g = adminGrant(
      ctx,
      'org_mode.scan.scanner.create',
      test.userId,
      authority,
      orgId,
      [...templatesUsable([templateId])],
      SCANNER_CODES,
      id,
    );
    addScannerInsert(g, {
      id,
      kind: 'terminal',
      name: SANDBOX_TERMINAL_NAME,
      eventId: null,
      settings: JSON.stringify(DEFAULT_SETTINGS),
      timeZone: 'UTC',
      expiresAt: now + TERMINAL_TTL_MS,
      createdBy: test.userId,
      now,
    });
    addScannerTemplates(g, id, [templateId]);
    g.add(
      audited(g, ctx, {
        orgId,
        actorType: 'user',
        actorId: test.userId,
        action: 'scanner.create',
        targetType: 'scanner',
        targetId: id,
        detail: { kind: 'terminal', mode: 'test', accepts: 'templates' },
      }),
    );
    await g.commit();
  } catch (error) {
    ctx.log.error('developer.sandbox_terminal_failed', {
      orgId,
      code: 'SANDBOX_TERMINAL_FAILED',
      error,
    });
  }
}
