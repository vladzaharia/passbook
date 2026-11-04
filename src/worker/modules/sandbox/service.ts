import type { z } from 'zod';
import type { Mode } from '../../../shared/contracts/common.ts';
import type {
  CapturedEmailDetailSchema,
  CapturedEmailSchema,
} from '../../../shared/contracts/index.ts';
import { NotFoundError, ValidationError } from '../../platform/errors.ts';
import { enforceRateLimit } from '../../platform/rate-limit.ts';
import type { ServiceContext } from '../../platform/service-context.ts';
import { recordAudit } from '../audit/service.ts';
import { depsOf } from '../passes/deps.ts';
import type { Actor } from '../passes/service.ts';
import { getPlatformSettings } from '../settings/service.ts';
import { type CapturedRow, getCaptured, listCaptured, verifiedEmailOf } from './repo.ts';

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

/** Captured mail is test data: a live caller sees none. */
export async function listCapturedEmails(
  ctx: ServiceContext,
  q: { mode: Mode; orgId?: string | undefined; cursor?: string | undefined; limit: number },
): Promise<{ items: Summary[]; nextCursor: string | null }> {
  if (q.mode !== 'test') return { items: [], nextCursor: null };
  const rows = await listCaptured(ctx.env.DB, q);
  const page = rows.slice(0, q.limit);
  return {
    items: page.map(summaryOf),
    nextCursor: rows.length > q.limit ? (page.at(-1)?.id ?? null) : null,
  };
}

async function requireCaptured(ctx: ServiceContext, id: string): Promise<CapturedRow> {
  const row = await getCaptured(ctx.env.DB, id);
  if (!row) throw new NotFoundError('Email not found.', 'CAPTURED_EMAIL_NOT_FOUND');
  return row;
}

/** By id, in either mode, like every get. */
export async function getCapturedEmail(ctx: ServiceContext, id: string): Promise<Detail> {
  const row = await requireCaptured(ctx, id);
  return { ...summaryOf(row), html: row.html, text: row.text };
}

/**
 * Sends a captured message to the signed-in admin's own verified address, never to the original
 * recipient. Rate limited per admin and audited.
 */
export async function sendCapturedToMe(
  ctx: ServiceContext,
  actor: Actor,
  id: string,
): Promise<{ to: string }> {
  if (actor.type !== 'user' || !actor.id)
    throw new ValidationError('Sign in as an admin to send a test email.', [], 'NOT_A_USER');
  const row = await requireCaptured(ctx, id);
  const to = await verifiedEmailOf(ctx.env.DB, actor.id);
  if (!to) throw new ValidationError('Verify your email address first.', [], 'NO_VERIFIED_EMAIL');
  await enforceRateLimit(ctx.env, 'RL_REFRESH', `RL_REFRESH:sandbox-send:${actor.id}`);
  const platform = await getPlatformSettings(ctx);
  await depsOf(ctx.env).mailer.send({
    to,
    subject: `[Test] ${row.subject}`,
    html: row.html,
    text: row.text,
    fromName: platform['email.senderName'],
  });
  await recordAudit(ctx, {
    orgId: row.org_id,
    actorType: actor.type,
    actorId: actor.id,
    action: 'sandbox.send_to_me',
    targetType: 'captured_email',
    targetId: row.id,
  });
  return { to };
}
