import { SANDBOX_TERMINAL_NAME } from '../../../shared/copy/developer.ts';
import type { SessionAuth } from '../../platform/auth.ts';
import { batch, first, stmt } from '../../platform/db.ts';
import type { ServiceContext } from '../../platform/service-context.ts';
import { DEFAULT_SETTINGS } from '../scan/dto-console.ts';
import { TERMINAL_TTL_MS } from '../scan/pairing-token.ts';

/**
 * The sandbox's one terminal: Test only, accepts the Quickstart ticket, never paired. The sandbox key scans as it
 * (`keyActsAsTerminalSql`). A retry finds it already made; a failure is logged and the sandbox stays usable.
 */
export async function ensureSandboxTerminal(
  ctx: ServiceContext,
  test: SessionAuth,
  orgId: string,
  templateId: string | null,
): Promise<void> {
  if (templateId === null) return;
  const live = await first<{ ok: number }>(
    ctx.env.DB,
    `SELECT 1 AS ok FROM scanners WHERE org_id = ? AND mode = 'test' AND name = ? AND revoked_at IS NULL
       AND (expires_at IS NULL OR expires_at > ?)`,
    [orgId, SANDBOX_TERMINAL_NAME, ctx.clock.now()],
  );
  if (live) return;
  try {
    const id = ctx.ids.id();
    const now = ctx.clock.now();
    // Written directly, not through the Scanning service: a sandbox's device quota is 0, and this one
    // is the sandbox's own fixture, not a device the person made.
    await batch(ctx.env.DB, [
      stmt(
        ctx.env.DB,
        `INSERT INTO scanners (id, org_id, mode, kind, device_role, name, settings, time_zone, expires_at, created_by, created_at, updated_at)
         VALUES (?, ?, 'test', 'terminal', 'scan', ?, ?, 'UTC', ?, ?, ?, ?)`,
        [
          id,
          orgId,
          SANDBOX_TERMINAL_NAME,
          JSON.stringify(DEFAULT_SETTINGS),
          now + TERMINAL_TTL_MS,
          test.userId,
          now,
          now,
        ],
      ),
      stmt(ctx.env.DB, 'INSERT INTO scanner_templates (scanner_id, template_id) VALUES (?, ?)', [
        id,
        templateId,
      ]),
    ]);
  } catch (error) {
    ctx.log.error('developer.sandbox_terminal_failed', {
      orgId,
      code: 'SANDBOX_TERMINAL_FAILED',
      error,
    });
  }
}
