import type { z } from 'zod';
import type { Mode } from '../../../shared/contracts/common.ts';
import type {
  CapturedEmailDetailSchema,
  CapturedEmailSchema,
} from '../../../shared/contracts/index.ts';
import {
  ConflictError,
  NotFoundError,
  UnavailableError,
  UpstreamError,
  ValidationError,
} from '../../platform/errors.ts';
import { enforceRateLimit } from '../../platform/rate-limit.ts';
import type { ServiceContext } from '../../platform/service-context.ts';
import { recordAudit } from '../audit/service.ts';
import type { MailAttachment, Mailer } from '../delivery/mailer.ts';
import { depsOf } from '../passes/deps.ts';
import { getPlatformSettings } from '../settings/service.ts';
import { resolveCaptureSnapshot } from './binding.ts';
import { verifiedEmailOf } from './repo.ts';
import {
  type CapturedRow,
  getCaptured,
  getCapturedReference,
  type InboxAuthority,
  listCaptured,
  readCaptured,
} from './repo-capture.ts';
import {
  finishForward,
  forwardingState,
  readForwardContent,
  reserveForward,
  userRevisionOf,
} from './repo-forward.ts';

const MAX_PAGE = 200;

type Summary = z.infer<typeof CapturedEmailSchema>;
type Detail = z.infer<typeof CapturedEmailDetailSchema>;

const summaryOf = (r: CapturedRow): Summary => ({
  id: r.id,
  orgId: r.org_id,
  kind: r.bundle_id ? 'bundle' : 'pass',
  passId: r.pass_id,
  bundleId: r.bundle_id,
  to: r.recipient,
  subject: r.subject,
  attached: r.attached === 1,
  createdAt: r.created_at,
});

/** Captured mail is test data: a live caller sees none. One query: no stored message is skipped. */
export async function listCapturedEmails(
  ctx: ServiceContext,
  q: { mode: Mode; orgId: string; cursor?: string | undefined; limit: number },
  authority: InboxAuthority,
): Promise<{ items: Summary[]; nextCursor: string | null }> {
  if (q.mode !== 'test' || authority.mode !== 'test' || q.orgId !== authority.orgId)
    return { items: [], nextCursor: null };
  const rows = await listCaptured(
    ctx.env.DB,
    { ...q, limit: Math.min(q.limit, MAX_PAGE) + 1 },
    authority,
    ctx.clock.now(),
  );
  const page = rows.slice(0, Math.min(q.limit, MAX_PAGE));
  return {
    items: page.map(summaryOf),
    nextCursor: rows.length > page.length ? (page.at(-1)?.id ?? null) : null,
  };
}

/** Read the stored message in the session's selected organization, current or not. */
export async function getCapturedEmail(
  ctx: ServiceContext,
  id: string,
  authority: InboxAuthority,
): Promise<Detail> {
  const row = await getCaptured(ctx.env.DB, id, authority, ctx.clock.now());
  if (!row) throw new NotFoundError('Email not found.', 'CAPTURED_EMAIL_NOT_FOUND');
  const forwarding = await forwardingState(ctx.env.DB, id, authority, ctx.clock.now());
  if (forwarding === null) throw new NotFoundError('Email not found.', 'CAPTURED_EMAIL_NOT_FOUND');
  return { ...summaryOf(row), html: row.html, text: row.text, forwarding };
}

/** Forward one captured message only after durably reserving its exact current snapshot. */
export async function sendCapturedToMe(
  ctx: ServiceContext,
  authority: InboxAuthority,
  id: string,
): Promise<{ to: string }> {
  if (
    authority.kind !== 'session' ||
    authority.mode !== 'test' ||
    authority.capability !== 'passes:operate'
  )
    throw new NotFoundError('Email not found.', 'CAPTURED_EMAIL_NOT_FOUND');
  const db = ctx.env.DB;
  const ref = await getCapturedReference(db, id, authority, ctx.clock.now());
  if (!ref) throw new NotFoundError('Email not found.', 'CAPTURED_EMAIL_NOT_FOUND');
  const snapshot = await resolveCaptureSnapshot(db, ref);
  if (!snapshot || !(await readCaptured(db, ref, snapshot, false, authority, ctx.clock.now())))
    throw new ConflictError(
      'The email or account changed. Reload and try again.',
      'TEST_FORWARD_CHANGED',
    );
  const to = await verifiedEmailOf(db, authority.userId);
  if (!to) throw new ValidationError('Verify your email address first.', [], 'NO_VERIFIED_EMAIL');
  await enforceRateLimit(ctx.env, 'RL_REFRESH', `RL_REFRESH:sandbox-send:${authority.userId}`);

  const attemptId = ctx.ids.id();
  const userRevision = await userRevisionOf(db, authority.userId);
  if (!(await reserveForward(ctx, attemptId, ref, snapshot, authority, to))) {
    // Distinguish a stale capture or account from a concurrent attempt.
    if (!(await verifiedEmailOf(db, authority.userId)))
      throw new ValidationError('Verify your email address first.', [], 'NO_VERIFIED_EMAIL');
    const state = await forwardingState(db, id, authority, ctx.clock.now());
    if (state === null) throw new NotFoundError('Email not found.', 'CAPTURED_EMAIL_NOT_FOUND');
    if (state === 'none' || state === 'failed' || state === 'sent')
      throw new ConflictError(
        'The email or account changed. Reload and try again.',
        'TEST_FORWARD_CHANGED',
      );
    throw new ConflictError(
      'This captured email is being sent or its delivery outcome is unknown.',
      'TEST_FORWARD_ALREADY_ATTEMPTED',
    );
  }

  let mailer: Mailer;
  let email: CapturedRow;
  let fromName: string;
  let attachments: MailAttachment[] | undefined;
  try {
    mailer = depsOf(ctx.env).mailer;
    fromName = (await getPlatformSettings(ctx))['email.senderName'];
    if (ref.attached === 1) {
      if (snapshot.kind !== 'pass') throw new Error('Invalid captured attachment.');
      const object = await ctx.env.BUCKET.get(snapshot.pass.objectKey);
      if (!object) throw new Error('Captured attachment is missing.');
      attachments = [
        {
          filename: 'pass.pkpass',
          type: 'application/vnd.apple.pkpass',
          content: new Uint8Array(await object.arrayBuffer()),
        },
      ];
    }
    // Check the exact intent, members, grant and verified address at the provider boundary.
    const content = await readForwardContent(
      db,
      attemptId,
      ref,
      snapshot,
      authority,
      to,
      ctx.clock.now(),
    );
    if (!content) throw new Error('Captured message changed.');
    email = content;
  } catch (error) {
    // No provider call has happened, so an explicit user retry can be safe.
    ctx.log.warn('sandbox.forward_preparation_failed', {
      code: 'TEST_FORWARD_PREPARATION',
      reason: error instanceof Error ? error.name : typeof error,
    });
    await finishForward(ctx, attemptId, authority, 'failed', userRevision);
    throw new UnavailableError(
      'The test email could not be prepared. Nothing was sent.',
      'TEST_FORWARD_PREPARATION_FAILED',
    );
  }

  try {
    await mailer.send({
      to,
      subject: `[Test] ${email.subject}`,
      html: email.html,
      text: email.text,
      fromName,
      ...(attachments ? { attachments } : {}),
    });
  } catch (error) {
    // Mailer rejection can happen after acceptance. Never retry; the lock expires after a day.
    ctx.log.warn('sandbox.forward_mailer_failed', {
      code: 'TEST_FORWARD_MAILER',
      reason: error instanceof Error ? error.name : typeof error,
    });
    await finishForward(ctx, attemptId, authority, 'unknown', userRevision);
    throw new UpstreamError(
      'The provider outcome is unknown. Do not send this message again.',
      'TEST_FORWARD_OUTCOME_UNKNOWN',
    );
  }
  // If this write fails after acceptance, the still-sending reservation remains a fence.
  await finishForward(ctx, attemptId, authority, 'sent', userRevision);
  await recordAudit(ctx, {
    orgId: ref.org_id,
    actorType: 'user',
    actorId: authority.userId,
    action: 'sandbox.send_to_me',
    targetType: 'captured_email',
    targetId: id,
  });
  return { to };
}
