import { issueToken } from '../../platform/capability-token.ts';
import { ConflictError, ValidationError } from '../../platform/errors.ts';
import type { ServiceContext } from '../../platform/service-context.ts';
import { recordAudit } from '../audit/service.ts';
import type { DeliveryActor } from '../delivery/delivery-actor.ts';
import { enqueuePassEmail } from '../delivery/issuance-intent.ts';
import { isPreviewOnlyOrg } from '../developer/fence.ts';
import { recordPassEvent } from '../events/record.ts';
import { assertPassDetailReadable, linksOf } from './detail.ts';
import type { TenantPassWrite } from './http.ts';
import { getPassForWrite } from './pass-access.ts';
import { setDownloadToken } from './repo.ts';
import { setDownloadTokenGranted } from './repo-pass-grants.ts';
import type { ScopeArg } from './scope.ts';
import type { Actor } from './service.ts';

export async function rotateLink(
  ctx: ServiceContext,
  actor: Actor,
  passId: string,
  scope: ScopeArg,
  authority?: TenantPassWrite,
) {
  const pass = await getPassForWrite(ctx.env.DB, passId, scope);
  const token = await issueToken(ctx.env, 'pass', passId, pass.orgId, ctx.ids.token());
  const tokenSet = authority
    ? await setDownloadTokenGranted(ctx, pass, token, authority)
    : await setDownloadToken(ctx.env.DB, pass, token, ctx.clock.now());
  if (!tokenSet)
    throw new ConflictError('The pass or authorization changed. Retry.', 'PASS_CONFLICT');
  await recordAudit(ctx, {
    orgId: pass.orgId,
    actorType: actor.type,
    actorId: actor.id,
    action: 'pass.rotate_link',
    targetType: 'pass',
    targetId: passId,
  });
  await recordPassEvent(ctx, {
    orgId: pass.orgId,
    passId,
    mode: pass.mode,
    kind: 'pass.link_rotated',
    actor,
  });
  const rotated = { ...pass, downloadToken: token.mac, linkGeneration: pass.linkGeneration + 1 };
  const { publicUrl, downloadUrl } = await linksOf(ctx, rotated, token.token);
  await assertPassDetailReadable(ctx, rotated, authority);
  return { publicUrl, downloadUrl };
}

/** A pass or bundle link is a credential: sending it to an address other than the holder's takes an org admin. */
export function mayMailElsewhere(actor: Actor, authority?: TenantPassWrite): boolean {
  return (
    actor.type === 'user' && authority?.kind === 'session' && authority.roles.includes('org_admin')
  );
}

export async function resendEmail(
  ctx: ServiceContext,
  actor: Actor,
  passId: string,
  input: { to?: string; attach?: boolean },
  scope: ScopeArg,
  authority?: TenantPassWrite,
  /** A deferred run's starter: the queueing batch proves its revisions. */
  queuedFor?: DeliveryActor[],
  /** A bulk run: its id goes in the audit. */
  runId?: string,
): Promise<void> {
  const pass = await getPassForWrite(ctx.env.DB, passId, scope);
  if (pass.removedAt !== null)
    throw new ConflictError('This pass was removed from Wallet. Restore it first.', 'PASS_REMOVED');
  const to = input.to ?? pass.holderEmail;
  if (!to) throw new ValidationError('The pass has no holder email.', [], 'NO_RECIPIENT');
  // Only an organization admin may send the pass link to another address; keys and operators send to the holder.
  if (to.toLowerCase() !== pass.holderEmail?.toLowerCase() && !mayMailElsewhere(actor, authority))
    throw new ValidationError('Only the holder email can be used.', [], 'RECIPIENT_NOT_HOLDER');
  await enqueuePassEmail(ctx, {
    passId,
    to,
    // A developer org's mail carries no pass file, whatever the caller asks.
    attach: (input.attach ?? false) && !(await isPreviewOnlyOrg(ctx.env.DB, pass.orgId)),
    expected: pass,
    auditEntry: {
      orgId: pass.orgId,
      actorType: actor.type,
      actorId: actor.id,
      action: 'pass.resend_email',
      targetType: 'pass',
      targetId: passId,
      ...(runId ? { detail: { runId } } : {}),
    },
    ...(authority ? { authority } : {}),
    ...(queuedFor ? { queuedFor } : {}),
  });
}
