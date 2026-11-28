import { ForbiddenError } from '../../platform/errors.ts';
import type { ServiceContext } from '../../platform/service-context.ts';
import { grantedAudit } from '../audit/repo-granted.ts';
import { endBinding, type TagActor } from '../nfc/repo-tags-write.ts';
import { triggerRefusal } from '../nfc/tags.ts';
import type { ScanActor } from './guard.ts';
import { boundRow } from './repo-tags-bind.ts';
import { scanWriteGrant } from './scan-write-grant.ts';
import { scannerRefusal } from './scanner-credential-lost.ts';
import { notFound, TABLES } from './tags-bind.ts';
import { TAG_UNDO_MS } from './tags-bind-replay.ts';
import { tagRights } from './tags-inspect.ts';

/** Ends a binding this device made in the last 10 minutes. The tag stays; what it replaced is not restored. */
export async function undoOnScanner(
  ctx: ServiceContext,
  actor: ScanActor,
  bindingId: string,
): Promise<{ status: 'undone'; bindingId: string }> {
  try {
    const { scannerId } = tagRights(actor);
    const row = await boundRow(ctx.env.DB, bindingId);
    if (!row || row.orgId !== actor.orgId || row.mode !== actor.mode || row.endedAt !== null)
      throw notFound();
    if (row.scannerId !== scannerId || row.source !== 'scanner')
      throw new ForbiddenError(
        'Undo is on the scanner that assigned the tag.',
        'TAG_UNDO_FORBIDDEN',
      );
    const now = ctx.clock.now();
    if (now - row.boundAt > TAG_UNDO_MS)
      throw new ForbiddenError('Undo timed out. An admin can remove the tag.', 'TAG_UNDO_EXPIRED');
    const staff = actor.staff;
    const by: TagActor = staff
      ? { type: 'staff', id: staff.id }
      : { type: 'scanner', id: scannerId };
    const g = scanWriteGrant(ctx, actor, {
      purpose: 'org_mode.scan.tag.unbind',
      now,
      codes: { stale: 'TAG_HOLDER_CHANGED' },
      tables: TABLES,
    });
    endBinding(g, row, 'undo', by, now);
    // Undoing the takeover of a lost tag puts the lost report back.
    if (row.clearedLostAt !== null)
      g.update('nfc_tags', {
        set: { lost_at: row.clearedLostAt, lost_by: row.clearedLostBy ?? 'unknown' },
        where: { id: row.tagId },
      });
    grantedAudit(g, ctx, {
      orgId: actor.orgId,
      actorType: 'scanner',
      actorId: scannerId,
      action: 'tag.unbind',
      targetType: 'tag',
      targetId: row.tagId,
      detail: { cause: 'undo', scope: row.scope, scannerId },
    });
    try {
      await g.commit();
    } catch (error) {
      throw triggerRefusal(error) ?? error;
    }
    return { status: 'undone', bindingId };
  } catch (error) {
    throw await scannerRefusal(ctx, actor, error);
  }
}
