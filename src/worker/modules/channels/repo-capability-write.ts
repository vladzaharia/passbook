import type { Channel } from '../../../shared/contracts/channels.ts';
import { jobGrant } from '../../platform/authority.ts';
import { exists, notExists } from '../../platform/authority-cond.ts';
import type { ServiceContext } from '../../platform/service-context.ts';

export interface CapabilityRow {
  channel: Channel;
  retiredAt: number | null;
  retiredCause: 'template' | null;
  /** The row revision read, absent when there was none. */
  seen: number | undefined;
}

/** Markers and audits for a capability change on one pass, in one job grant. A moved row refuses (CHANNEL_APPLY_STALE). */
export async function writeCapabilityChange(
  ctx: ServiceContext,
  pass: { id: string; orgId: string; mode: 'live' | 'test'; templateId: string },
  rows: CapabilityRow[],
  audits: Record<string, unknown>[],
): Promise<void> {
  const g = jobGrant(ctx, {
    purpose: 'org_mode.job.channels.capability',
    job: 'channel-capability',
    orgId: pass.orgId,
    mode: pass.mode,
    target: pass.id,
    tables: ['pass_channels'],
    codes: { stale: 'CHANNEL_APPLY_STALE' },
  });
  const now = ctx.clock.now();
  for (const r of rows) {
    g.assert('stale', [
      r.seen === undefined
        ? notExists('pass_channels', { pass_id: pass.id, channel: r.channel })
        : exists('pass_channels', { pass_id: pass.id, channel: r.channel, revision: r.seen }),
    ]);
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
      [
        pass.id,
        pass.templateId,
        r.channel,
        null,
        r.retiredAt,
        r.retiredCause,
        'channel-capability',
        now,
      ],
      { update: ['retired_at', 'retired_cause', 'set_by', 'set_at'], inc: ['revision'] },
    );
  }
  for (const detail of audits)
    g.audit({
      at: now,
      orgId: pass.orgId,
      actorType: 'system',
      actorId: 'channel-capability',
      action: 'pass.channels_change',
      targetType: 'pass',
      targetId: pass.id,
      requestId: null,
      ipPrefix: null,
      detail: JSON.stringify(detail),
    });
  await g.commit();
}
