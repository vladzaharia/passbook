import type { z } from 'zod';
import type { ScanTagEnrollmentSchema } from '../../../shared/contracts/nfc-tag-enrollments.ts';
import { exactlyOne } from '../../platform/authority-checks.ts';
import { exists } from '../../platform/authority-cond.ts';
import { AppError, ConflictError, NotFoundError } from '../../platform/errors.ts';
import type { ServiceContext } from '../../platform/service-context.ts';
import { grantedAudit } from '../audit/repo-granted.ts';
import { tagsEnabled } from '../nfc/policy.ts';
import {
  deviceFacts,
  type EnrollmentRow,
  enrollmentRow,
  pendingForScanner,
} from '../nfc/repo-enrollments.ts';
import { ENROLL_TABLES } from '../nfc/repo-tags-write.ts';
import type { ScanActor } from './guard.ts';
import { scanWriteGrant } from './scan-write-grant.ts';
import { scannerRefusal } from './scanner-credential-lost.ts';
import { tagRights } from './tags-inspect.ts';

type Pending = z.infer<typeof ScanTagEnrollmentSchema>;

export const CODES = {
  lineage: 'TAG_HOLDER_CHANGED',
  stale: 'ENROLLMENT_ENDED',
  retention: 'TAG_REQUEST_REVOKED',
} as const;

export const notFound = () => new NotFoundError('Request not found.', 'ENROLLMENT_NOT_FOUND');

/** The request is this device's, in its org and mode. Any other id answers the same 404. */
export async function ownRequest(
  ctx: ServiceContext,
  actor: ScanActor,
  id: string,
  scannerId: string,
) {
  const row = await enrollmentRow(ctx.env.DB, id);
  if (!row || row.orgId !== actor.orgId || row.mode !== actor.mode || row.scannerId !== scannerId)
    throw notFound();
  return row;
}

/** Still pending: ended and lapsed requests answer with their own codes. */
export function openRequest(row: EnrollmentRow, now: number): void {
  if (row.state !== 'pending') throw new ConflictError('This request is over.', 'ENROLLMENT_ENDED');
  if (row.expiresAt <= now)
    throw new ConflictError('This request expired. Ask for a new one.', 'TAG_REQUEST_EXPIRED');
}

export async function guarded<T>(
  ctx: ServiceContext,
  actor: ScanActor,
  run: () => Promise<T>,
): Promise<T> {
  try {
    return await run();
  } catch (error) {
    const refusal = await scannerRefusal(ctx, actor, error);
    if (refusal instanceof AppError)
      ctx.log.warn('scan.tag.enroll.refused', { orgId: actor.orgId, code: refusal.code });
    throw refusal;
  }
}

/**
 * The device's open request: only the holder's name, the pass title and the expiry. Fetching it marks the
 * request shown, which the admin page reads. A request whose pass changed hands answers none.
 */
export function pendingEnrollment(
  ctx: ServiceContext,
  actor: ScanActor,
): Promise<{ enrollment: Pending | null }> {
  return guarded(ctx, actor, async () => {
    const { scannerId } = tagRights(actor);
    const none = { enrollment: null };
    if (!(await tagsEnabled(ctx, actor.orgId))) return none;
    const row = await pendingForScanner(ctx.env.DB, actor.orgId, actor.mode, scannerId);
    const now = ctx.clock.now();
    if (!row || row.expiresAt <= now) return none;
    const facts = await deviceFacts(ctx.env.DB, row);
    if (
      facts.deleted ||
      facts.credentialGeneration !== row.holderGeneration ||
      facts.ownerId !== row.holderOwner
    )
      return none;
    if (row.shownAt === null) {
      const g = scanWriteGrant(ctx, actor, {
        purpose: 'org_mode.scan.tag.enroll',
        now,
        checks: [
          exactlyOne('tag_enrollments', { id: row.id, state: 'pending' }, undefined, 'stale'),
        ],
        codes: CODES,
        tables: [...ENROLL_TABLES],
      });
      g.update('tag_enrollments', {
        set: { shown_at: now },
        where: { id: row.id, state: 'pending', scanner_id: scannerId },
      });
      await g.commit();
    }
    return {
      enrollment: {
        id: row.id,
        holderName: facts.holderName ?? facts.passTitle ?? facts.templateName,
        passTitle: facts.passTitle ?? facts.templateName,
        scope: row.scope,
        requestedByName: facts.requestedByName,
        expiresAt: row.expiresAt,
      },
    };
  });
}

/** The device turns the request down. */
export function declineEnrollment(
  ctx: ServiceContext,
  actor: ScanActor,
  id: string,
): Promise<{ status: 'declined' }> {
  return guarded(ctx, actor, async () => {
    const { scannerId } = tagRights(actor);
    const row = await ownRequest(ctx, actor, id, scannerId);
    const now = ctx.clock.now();
    openRequest(row, now);
    const g = scanWriteGrant(ctx, actor, {
      purpose: 'org_mode.scan.tag.enroll',
      now,
      checks: [
        exactlyOne(
          'tag_enrollments',
          { id, scanner_id: scannerId, state: 'pending' },
          undefined,
          'stale',
        ),
      ],
      codes: CODES,
      tables: [...ENROLL_TABLES],
    });
    g.update('tag_enrollments', {
      set: { state: 'declined', ended_at: now },
      where: { id, state: 'pending' },
    });
    grantedAudit(
      g,
      ctx,
      {
        orgId: actor.orgId,
        actorType: 'device',
        actorId: scannerId,
        action: 'tag.enroll.decline',
        targetType: 'enrollment',
        targetId: id,
        detail: { passId: row.passId, scannerId },
      },
      [exists('tag_enrollments', { id, state: 'declined' })],
    );
    await g.commit();
    return { status: 'declined' };
  });
}
