import { gte, isNotNull } from '../../platform/authority-expr.ts';
import { ValidationError } from '../../platform/errors.ts';
import type { ServiceContext } from '../../platform/service-context.ts';
import type { ScanActor } from './guard.ts';
import { scanWriteGrant } from './scan-write-grant.ts';

/** Why they were let in can be added for two minutes, by the person who did it. */
const NOTE_WINDOW_MS = 2 * 60_000;

export async function setOverrideNote(
  ctx: ServiceContext,
  actor: ScanActor,
  scanId: string,
  note: string,
): Promise<void> {
  const now = ctx.clock.now();
  const g = scanWriteGrant(ctx, actor, {
    purpose: 'org_mode.scan.check_in',
    now,
    tables: ['scans'],
  });
  const updated = g.update('scans', {
    set: { override_note: note },
    where: {
      id: scanId,
      actor_key: actor.actorKey,
      staff_id: actor.staff?.id ?? null,
      state: 'done',
      outcome: 'ok',
      override_of: isNotNull(),
      override_note: null,
      undone_at: null,
      at: gte(now - NOTE_WINDOW_MS),
    },
    returning: ['id'],
  });
  const results = await g.commit();
  if (!(results[g.indexOf(updated)]?.results ?? []).length)
    throw new ValidationError('That note can no longer be added.', [], 'SCAN_OVERRIDE_NOTE_CLOSED');
}
