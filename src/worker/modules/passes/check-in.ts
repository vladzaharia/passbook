import { type CheckInPolicy, CheckInPolicySchema } from '../../../shared/contracts/check-in.ts';
import { scanOf } from '../../../shared/scan-defaults.ts';
import { NotFoundError, ValidationError } from '../../platform/errors.ts';
import type { ServiceContext } from '../../platform/service-context.ts';
import { recordAudit } from '../audit/service.ts';
import { getEvent } from '../scan/repo-scope.ts';
import { resolveTemplate } from './builder.ts';
import { getPassForWrite } from './pass-access.ts';
import { getPass } from './repo.ts';
import { passCheckIn, savePassCheckIn } from './repo-check-in.ts';
import type { ScopeArg } from './scope.ts';
import type { Actor } from './service.ts';

export async function getPassCheckIn(ctx: ServiceContext, passId: string, scope: ScopeArg) {
  const pass = await getPass(ctx.env.DB, passId, scope);
  if (!pass) throw new NotFoundError('Pass not found.', 'PASS_NOT_FOUND');
  const template = await resolveTemplate(ctx, pass.orgId, pass.templateId, pass.templateVersion);
  const scan = scanOf(template.manifest);
  const action = scan.actions.find((a) => a.kind === 'check_in');
  const from = scan.window?.from ? Date.parse(String(pass.personalization[scan.window.from])) : NaN;
  const until = scan.window?.until
    ? Date.parse(String(pass.personalization[scan.window.until]))
    : NaN;
  const defaults: CheckInPolicy = {
    mode: action?.repeat === 'once' ? 'single' : action?.repeat === 'daily' ? 'daily' : 'unlimited',
    validFrom: Number.isFinite(from) ? from - (scan.window?.earlyMinutes ?? 0) * 60_000 : null,
    validUntil: Number.isFinite(until) ? until + (scan.window?.lateMinutes ?? 0) * 60_000 : null,
  };
  const stored = await passCheckIn(ctx.env.DB, pass.orgId, passId);
  return {
    passId,
    orgId: pass.orgId,
    ...stored,
    defaults,
    effective: { ...defaults, ...stored.rules },
  };
}

export async function putPassCheckIn(
  ctx: ServiceContext,
  actor: Actor,
  passId: string,
  rules: CheckInPolicy,
  scope: ScopeArg,
) {
  const pass = await getPassForWrite(ctx.env.DB, passId, scope);
  const current = await getPassCheckIn(ctx, passId, scope);
  if (!CheckInPolicySchema.safeParse({ ...current.defaults, ...rules }).success)
    throw new ValidationError(
      'End must be after start; check the inherited template dates.',
      [],
      'SCAN_WINDOW_INVALID',
    );
  if (rules.eventId) {
    const event = await getEvent(ctx.env.DB, pass.orgId, rules.eventId);
    if (!event || event.mode !== pass.mode || event.archivedAt !== null)
      throw new NotFoundError('Event not found.', 'SCAN_EVENT_NOT_FOUND');
  }
  await savePassCheckIn(ctx.env.DB, pass.orgId, passId, rules, ctx.clock.now());
  await recordAudit(ctx, {
    orgId: pass.orgId,
    actorType: actor.type,
    actorId: actor.id,
    action: 'pass.check_in.put',
    targetType: 'pass',
    targetId: passId,
    detail: { mode: rules.mode ?? null },
  });
  return getPassCheckIn(ctx, passId, scope);
}
