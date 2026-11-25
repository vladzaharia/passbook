import type { Context } from 'hono';
import type { AppBindings } from '../../platform/context.ts';
import { ForbiddenError, UnauthenticatedError } from '../../platform/errors.ts';
import type { ServiceContext } from '../../platform/service-context.ts';
import type { ScanActor } from './actor.ts';
import { captureObservedScanningSession } from './scanning-workspace-observation.ts';
import { retriesCommitted } from './session-closed-retry.ts';
import { assertSessionOpen, sessionWindow } from './session-hours.ts';

/**
 * A write in a scanning session needs it active and inside its hours: a POST, the draft's PUT, and note
 * edits. A manager may sign in while closed, to open early; a retry of a committed action still answers.
 */
export async function assertSessionAdmits(
  c: Context<AppBindings>,
  ctx: ServiceContext,
  actor: ScanActor,
): Promise<void> {
  if (
    !actor.scanningSession ||
    !(
      c.req.method === 'POST' ||
      (c.req.method === 'PUT' && /\/draft$/.test(c.req.path)) ||
      (/^(PATCH|DELETE)$/.test(c.req.method) && /\/notes\/[^/]+$/.test(c.req.path))
    ) ||
    /\/(device|mark-out|unpair|open-now|batch)$/.test(c.req.path)
  )
    return;
  if (actor.scanningSession.status !== 'active')
    throw new ForbiddenError(
      'This scanning session is paused. Resume it in Scanning.',
      'SCANNING_SESSION_PAUSED',
    );
  // Decided now, from the row this request observed: a missed cron never admits a late scan.
  const parent = captureObservedScanningSession(actor)?.parent;
  if (!parent)
    throw new UnauthenticatedError('Pair this scanner to continue.', 'SCANNER_UNAUTHENTICATED');
  if (
    !/\/staff(?:\/pin)?$/.test(c.req.path) &&
    !(sessionWindow(parent, ctx.clock.now()).open || (await retriesCommitted(c, ctx.env.DB, actor)))
  )
    assertSessionOpen(parent, ctx.clock.now());
}
