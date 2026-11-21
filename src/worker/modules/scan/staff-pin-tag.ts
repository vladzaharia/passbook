import { classifyD1Error } from '../../platform/db.ts';
import type { ServiceContext } from '../../platform/service-context.ts';
import { auditStmt } from '../audit/repo.ts';
import type { ScannerRow } from './repo-device.ts';
import {
  fillPinTag,
  flagPinReset,
  pinStateGrant,
  pinTagStateStatement,
  staffWithTagStatement,
} from './repo-pin-tag.ts';
import { pinTag } from './staff-pin-hash.ts';

/** Staff whose PIN is held by someone else too: the next session asks each for a new PIN. */
async function flagSharedPin(
  ctx: ServiceContext,
  scanner: ScannerRow,
  ids: readonly string[],
): Promise<void> {
  const db = ctx.env.DB;
  const { orgId } = scanner;
  const g = pinStateGrant(ctx, scanner);
  for (const id of ids) flagPinReset(g, id);
  await g.commit();
  await db.batch(
    ids.map((id) =>
      auditStmt(db, ctx, {
        orgId,
        actorType: 'scanner',
        actorId: scanner.id,
        action: 'scan_staff.pin_shared',
        targetType: 'scan_staff',
        targetId: id,
      }),
    ),
  );
}

/**
 * After a PIN verified for this person: fill the tag of one from before tags. A tag that is already
 * another active person's is a shared PIN: both are flagged, and the session asks each for a new PIN.
 */
export async function afterVerifiedPin(
  ctx: ServiceContext,
  scanner: ScannerRow,
  staffId: string,
  pin: string,
): Promise<void> {
  const db = ctx.env.DB;
  const { orgId } = scanner;
  const row = await pinTagStateStatement(db, orgId, staffId).first<{
    pin_tag: string | null;
    pin_reset_required: number;
  }>();
  if (!row || row.pin_tag !== null) return;
  const tag = await pinTag(ctx.env, orgId, pin);
  try {
    const g = pinStateGrant(ctx, scanner);
    fillPinTag(g, staffId, tag);
    await g.commit();
  } catch (error) {
    if (classifyD1Error(error)?.kind !== 'unique') throw error;
    const other = await staffWithTagStatement(db, orgId, tag).first<{ id: string }>();
    await flagSharedPin(ctx, scanner, other ? [staffId, other.id] : [staffId]);
    ctx.log.warn('scan.pin_shared', { orgId, scannerId: scanner.id, code: 'PIN_SHARED' });
  }
}
