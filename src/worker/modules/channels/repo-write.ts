import type {
  Channel,
  PassChannelState,
  TemplateChannelState,
} from '../../../shared/contracts/channels.ts';
import { grant } from '../../platform/authority.ts';
import { exists, notExists } from '../../platform/authority-cond.ts';
import type { ServiceContext } from '../../platform/service-context.ts';
import type { TenantPassWrite } from '../passes/http.ts';
import { capabilityChecks, tenantPrincipal } from '../passes/repo-authority.ts';

interface AuditFields {
  action: string;
  targetType: string;
  targetId: string;
  detail: Record<string, unknown>;
}

function auditRow(
  ctx: ServiceContext,
  authority: TenantPassWrite,
  actor: { type: string; id: string | null },
  a: AuditFields,
) {
  return {
    at: ctx.clock.now(),
    orgId: authority.orgId,
    actorType: actor.type,
    actorId: actor.id,
    action: a.action,
    targetType: a.targetType,
    targetId: a.targetId,
    requestId: ctx.requestId ?? null,
    ipPrefix: null,
    detail: JSON.stringify(a.detail),
  };
}

export interface PassChannelWrite {
  channel: Channel;
  override: PassChannelState | null;
  retiredAt: number | null;
  retiredCause: 'pass' | 'template' | null;
}

/** One pass's channel rows and their audit rows, in one grant. Needs passes:operate or a passes:write key. */
export async function writePassChannels(
  ctx: ServiceContext,
  authority: TenantPassWrite,
  actor: { type: string; id: string | null },
  pass: { id: string; templateId: string },
  by: string,
  writes: PassChannelWrite[],
  audits: Record<string, unknown>[],
): Promise<void> {
  const g = grant(ctx, {
    purpose: 'org_mode.channels.override',
    principal: tenantPrincipal(authority),
    target: pass.id,
    tables: ['pass_channels'],
    checks: capabilityChecks(authority),
  });
  const now = ctx.clock.now();
  for (const w of writes)
    g.upsert(
      'pass_channels',
      [
        'pass_id',
        'template_id',
        'channel',
        'override',
        'retired_at',
        'retired_cause',
        'set_by',
        'set_at',
      ],
      [pass.id, pass.templateId, w.channel, w.override, w.retiredAt, w.retiredCause, by, now],
      {
        update: ['override', 'retired_at', 'retired_cause', 'set_by', 'set_at'],
        inc: ['revision'],
      },
    );
  for (const detail of audits)
    g.audit(
      auditRow(ctx, authority, actor, {
        action: 'pass.channels_change',
        targetType: 'pass',
        targetId: pass.id,
        detail,
      }),
    );
  await g.commit();
}

/** The channel-apply run a save opens, or joins when one is already pending. */
export interface ApplyRequest {
  runId: string;
  /** The stored policy before this save. */
  from: Partial<Record<Channel, TemplateChannelState>>;
  dueAt: number;
}

/** Saves a template's policy; a `never` also clears that channel's pass overrides (N1). */
export async function writeTemplatePolicy(
  ctx: ServiceContext,
  authority: TenantPassWrite,
  actor: { type: string; id: string | null },
  templateId: string,
  by: string,
  channels: Partial<Record<Channel, TemplateChannelState>>,
  cleared: Channel[],
  detail: Record<string, unknown>,
  revision: number,
  apply: ApplyRequest,
): Promise<void> {
  const g = grant(ctx, {
    purpose: 'org_mode.channels.policy',
    principal: tenantPrincipal(authority),
    target: templateId,
    tables: ['template_channel_policies', 'pass_channels', 'channel_apply_runs'],
    checks: capabilityChecks(authority),
    codes: { stale: 'TEMPLATE_CHANNELS_CHANGED' },
  });
  // The policy is still the revision the editor read (0: none yet).
  g.assert(
    'stale',
    revision === 0
      ? [notExists('template_channel_policies', { template_id: templateId })]
      : [exists('template_channel_policies', { template_id: templateId, revision })],
  );
  g.upsert(
    'template_channel_policies',
    ['template_id', 'channels', 'updated_by', 'updated_at'],
    [templateId, JSON.stringify(channels), by, ctx.clock.now()],
    { update: ['channels', 'updated_by', 'updated_at'], inc: ['revision'] },
  );
  for (const channel of cleared)
    g.update('pass_channels', {
      set: { override: null, set_by: by, set_at: ctx.clock.now() },
      inc: ['revision'],
      where: { template_id: templateId, channel },
    });
  // The save joins the template's pending run and pushes its start back, or opens one that begins
  // from the policy before this save.
  const now = ctx.clock.now();
  g.update('channel_apply_runs', {
    set: { due_at: apply.dueAt, updated_at: now },
    where: { template_id: templateId, state: 'pending' },
  });
  g.insertSelect(
    'channel_apply_runs',
    [
      'id',
      'template_id',
      'state',
      'from_channels',
      'from_revision',
      'requested_by',
      'due_at',
      'created_at',
      'updated_at',
    ],
    [
      apply.runId,
      templateId,
      'pending',
      JSON.stringify(apply.from),
      revision,
      by,
      apply.dueAt,
      now,
      now,
    ],
    { when: [notExists('channel_apply_runs', { template_id: templateId, state: 'pending' })] },
  );
  g.audit(
    auditRow(ctx, authority, actor, {
      action: 'template.channels_change',
      targetType: 'template',
      targetId: templateId,
      detail,
    }),
  );
  await g.commit();
}
