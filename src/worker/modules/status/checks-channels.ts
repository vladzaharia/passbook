import type { ServiceContext } from '../../platform/service-context.ts';
import type { Draft } from './checks.ts';
import { channelApplyAttention } from './repo.ts';

const MINUTE = 60_000;
const DAY = 86_400_000;

/** A failed run (24 h), a pending run 15 minutes past its start, a running run idle 30 minutes. */
export async function checkChannelApply(ctx: ServiceContext): Promise<Draft> {
  const base = { id: 'channel_apply', kind: 'workflow', label: 'Channel changes' } as const;
  const now = ctx.clock.now();
  try {
    const rows = await channelApplyAttention(ctx.env.DB, {
      failedSince: now - DAY,
      pendingDueBefore: now - 15 * MINUTE,
      runningIdleBefore: now - 30 * MINUTE,
    });
    const n = (state: string) => rows.filter((r) => r.state === state).length;
    const data = { failed: n('failed'), stuck_pending: n('pending'), stuck_running: n('running') };
    if (rows.length === 0) return { ...base, state: 'verified', detail: null, data };
    const parts = [
      data.failed && `${data.failed} failed`,
      data.stuck_pending && `${data.stuck_pending} not started`,
      data.stuck_running && `${data.stuck_running} stalled`,
    ].filter(Boolean);
    return {
      ...base,
      state: data.stuck_running ? 'failing' : 'degraded',
      detail: `${parts.join(', ')}.`,
      data,
    };
  } catch (error) {
    ctx.log.warn('status.probe_failed', {
      component: 'channel_apply',
      code: 'PROBE_FAILED',
      error,
    });
    return { ...base, state: 'failing', detail: 'Probe failed.' };
  }
}
