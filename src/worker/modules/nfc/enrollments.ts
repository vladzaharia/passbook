import type { Mode } from '../../../shared/contracts/common.ts';
import type { TagEnrollment } from '../../../shared/contracts/nfc-tag-enrollments.ts';
import { TagErrorCodeSchema } from '../../../shared/contracts/nfc-tags.ts';
import { exactlyOne } from '../../platform/authority-checks.ts';
import { exists } from '../../platform/authority-cond.ts';
import { lte } from '../../platform/authority-expr.ts';
import { classifyD1Error } from '../../platform/db.ts';
import { ConflictError, NotFoundError, ValidationError } from '../../platform/errors.ts';
import type { ServiceContext } from '../../platform/service-context.ts';
import { grantedAudit } from '../audit/repo-granted.ts';
import { scanHub } from '../scan/live.ts';
import { assertBindable } from './pass-state.ts';
import { tagsRefusal } from './policy.ts';
import {
  bindingHint,
  type EnrollmentRow,
  enrollmentRow,
  enrollScanners,
  ownerIsActive,
  pendingFor,
} from './repo-enrollments.ts';
import { passFacts } from './repo-tag-bindings.ts';
import { bindingView } from './repo-tag-history.ts';
import {
  bindChecks,
  ENROLL_TABLES,
  type SessionTagAuthority,
  tagGrant,
} from './repo-tags-write.ts';
import { commitTag } from './tags.ts';

/** A request lasts 90 seconds (master plan: study AN-4). */
export const ENROLL_TTL_MS = 90_000;

const notFound = () => new NotFoundError('Request not found.', 'ENROLLMENT_NOT_FOUND');

const KNOWN_CODES = new Set<string>(TagErrorCodeSchema.options);

export async function enrollmentView(
  ctx: ServiceContext,
  row: EnrollmentRow,
): Promise<TagEnrollment> {
  const now = ctx.clock.now();
  const lapsed = row.state === 'pending' && row.expiresAt <= now;
  return {
    id: row.id,
    passId: row.passId,
    scannerId: row.scannerId,
    scannerName: row.scannerName,
    scope: row.scope,
    state: lapsed ? 'expired' : row.state,
    createdAt: row.createdAt,
    expiresAt: row.expiresAt,
    endedAt: lapsed ? row.expiresAt : row.endedAt,
    shownAt: row.shownAt,
    binding: row.bindingId ? await bindingView(ctx.env.DB, row.bindingId) : null,
    hint: row.bindingId ? await bindingHint(ctx.env.DB, row.bindingId) : null,
    errorCode:
      row.errorCode && KNOWN_CODES.has(row.errorCode)
        ? (row.errorCode as TagEnrollment['errorCode'])
        : null,
  };
}

/** A hub that cannot be reached is a device that was not reached; the row stays the truth. */
async function ring(
  ctx: ServiceContext,
  row: Pick<EnrollmentRow, 'orgId' | 'mode' | 'scannerId' | 'id' | 'expiresAt'>,
  message: { id: string; expiresAt: number } | { id: string; cancelled: true },
): Promise<number> {
  try {
    return await scanHub(ctx, row.orgId, row.mode).enroll({
      orgId: row.orgId,
      mode: row.mode,
      scannerId: row.scannerId,
      enrollment: message,
      now: ctx.clock.now(),
    });
  } catch {
    ctx.log.warn('tag.enroll.ring_failed', { orgId: row.orgId, code: 'TAG_ENROLL_RING_FAILED' });
    return 0;
  }
}

/**
 * Asks a connected Desk or Operator scanner to read a tag for a pass. The row (TTL 90 s) is created in one
 * grant, and the hub is rung after it commits; a device no socket of which is open fails the request.
 */
export async function requestEnrollment(
  ctx: ServiceContext,
  a: SessionTagAuthority,
  passId: string,
  req: { scannerId: string; binding: 'pass' | 'user' },
): Promise<TagEnrollment> {
  const { orgId, mode } = a;
  const off = await tagsRefusal(ctx, orgId);
  if (off) throw off;
  const pass = await passFacts(ctx.env.DB, passId);
  if (!pass || pass.orgId !== orgId || pass.mode !== mode || pass.deletedAt !== null)
    throw new NotFoundError('Pass not found.', 'PASS_NOT_FOUND');
  await assertBindable(ctx, orgId, passId);
  if (req.binding === 'user' && !(await ownerIsActive(ctx.env.DB, pass.ownerUserId)))
    throw new ValidationError(
      'This person has no account yet. Assign the tag to the pass instead.',
      [],
      'TAG_NO_ACCOUNT',
    );
  const now = ctx.clock.now();
  const scanners = await enrollScanners(ctx.env.DB, orgId, mode, a.userId, now);
  const scanner = scanners.find((s) => s.id === req.scannerId);
  if (!scanner) throw new NotFoundError('Scanner not found.', 'SCANNER_NOT_FOUND');
  if (!scanner.nfcTags)
    throw new ConflictError('This scanner cannot read tags.', 'SCANNER_NO_TAGS');
  if (scanner.role === 'door' || scanner.assign === 'never')
    throw new ConflictError('This scanner does not take tag requests.', 'SCANNER_REQUESTS_OFF');
  const { live, stale } = await pendingFor(ctx.env.DB, scanner.id, passId, now);
  if (live.length > 0)
    throw new ConflictError(
      'A tag request is already open. Cancel it or wait.',
      'TAG_REQUEST_BUSY',
    );

  const id = ctx.ids.id();
  const expiresAt = now + ENROLL_TTL_MS;
  const g = tagGrant(
    ctx,
    'org_mode.nfc.tag.enroll_request',
    a,
    bindChecks({
      passId,
      holderGeneration: pass.credentialGeneration,
      holderOwner: pass.ownerUserId,
    }),
    ENROLL_TABLES,
  );
  for (const s of stale) {
    g.update('tag_enrollments', {
      set: { state: 'expired', ended_at: s.expiresAt },
      where: { id: s.id, state: 'pending', expires_at: lte(now) },
    });
    grantedAudit(
      g,
      ctx,
      {
        orgId,
        actorType: 'system',
        actorId: null,
        action: 'tag.enroll.expire',
        targetType: 'enrollment',
        targetId: s.id,
        detail: { passId: s.passId, scannerId: s.scannerId },
      },
      [exists('tag_enrollments', { id: s.id, state: 'expired' })],
    );
  }
  g.insertSelect(
    'tag_enrollments',
    [
      'id',
      'pass_id',
      'scanner_id',
      'requested_by',
      'scope',
      'user_id',
      'holder_generation',
      'holder_owner',
      'state',
      'created_at',
      'expires_at',
    ],
    [
      id,
      passId,
      scanner.id,
      a.userId,
      req.binding,
      req.binding === 'user' ? pass.ownerUserId : null,
      pass.credentialGeneration,
      pass.ownerUserId,
      'pending',
      now,
      expiresAt,
    ],
    { returning: ['id'] },
  );
  grantedAudit(
    g,
    ctx,
    {
      orgId,
      actorType: 'user',
      actorId: a.userId,
      action: 'tag.enroll.request',
      targetType: 'enrollment',
      targetId: id,
      detail: { scope: req.binding, passId, scannerId: scanner.id },
    },
    [exists('tag_enrollments', { id })],
  );
  try {
    await commitTag(g);
  } catch (error) {
    if (classifyD1Error(error)?.kind === 'unique')
      throw new ConflictError(
        'A tag request is already open. Cancel it or wait.',
        'TAG_REQUEST_BUSY',
      );
    throw error;
  }
  const reached = await ring(
    ctx,
    { orgId, mode, scannerId: scanner.id, id, expiresAt },
    { id, expiresAt },
  );
  if (reached === 0) {
    const f = tagGrant(
      ctx,
      'org_mode.nfc.tag.enroll_cancel',
      a,
      [exactlyOne('tag_enrollments', { id, state: 'pending' })],
      ENROLL_TABLES,
    );
    f.update('tag_enrollments', {
      set: { state: 'failed', ended_at: ctx.clock.now(), error_code: 'SCANNER_OFFLINE' },
      where: { id, state: 'pending' },
    });
    grantedAudit(
      f,
      ctx,
      {
        orgId,
        actorType: 'user',
        actorId: a.userId,
        action: 'tag.enroll.fail',
        targetType: 'enrollment',
        targetId: id,
        detail: { code: 'SCANNER_OFFLINE', passId, scannerId: scanner.id },
      },
      [exists('tag_enrollments', { id, state: 'failed' })],
    );
    await commitTag(f);
    throw new ConflictError('The scanner is offline. Open it and try again.', 'SCANNER_OFFLINE');
  }
  return view(ctx, orgId, mode, passId, id);
}

async function view(
  ctx: ServiceContext,
  orgId: string,
  mode: Mode,
  passId: string,
  id: string,
): Promise<TagEnrollment> {
  const row = await enrollmentRow(ctx.env.DB, id);
  if (!row || row.orgId !== orgId || row.mode !== mode || row.passId !== passId) throw notFound();
  return enrollmentView(ctx, row);
}

/** The request as the admin page polls it. The caller holds passes:read in this org and mode. */
export const getEnrollment = view;

/** Stops a pending request; the device is told so it stops asking for a tag. An ended request is returned as it is. */
export async function cancelEnrollment(
  ctx: ServiceContext,
  a: SessionTagAuthority,
  passId: string,
  id: string,
): Promise<TagEnrollment> {
  const row = await enrollmentRow(ctx.env.DB, id);
  if (!row || row.orgId !== a.orgId || row.mode !== a.mode || row.passId !== passId)
    throw notFound();
  if (row.state !== 'pending' || row.expiresAt <= ctx.clock.now()) return enrollmentView(ctx, row);
  const g = tagGrant(
    ctx,
    'org_mode.nfc.tag.enroll_cancel',
    a,
    [exactlyOne('tag_enrollments', { id, state: 'pending' })],
    ENROLL_TABLES,
  );
  g.update('tag_enrollments', {
    set: { state: 'cancelled', ended_at: ctx.clock.now() },
    where: { id, state: 'pending' },
  });
  grantedAudit(
    g,
    ctx,
    {
      orgId: a.orgId,
      actorType: 'user',
      actorId: a.userId,
      action: 'tag.enroll.cancel',
      targetType: 'enrollment',
      targetId: id,
      detail: { passId, scannerId: row.scannerId },
    },
    [exists('tag_enrollments', { id, state: 'cancelled' })],
  );
  await commitTag(g);
  await ring(ctx, row, { id, cancelled: true });
  return view(ctx, a.orgId, a.mode, passId, id);
}
