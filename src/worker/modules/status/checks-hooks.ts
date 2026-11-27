import type { ServiceContext } from '../../platform/service-context.ts';
import type { Draft } from './checks.ts';
import { type HookHealthRow, listHookHealth } from './repo-hooks.ts';

const iso = (at: number | null) => (at === null ? 'never' : new Date(at).toISOString());

/** A hook is failing when its last run failed: the failure is newer than the last success. */
const failing = (r: HookHealthRow) =>
  r.last_failure_at !== null &&
  (r.last_success_at === null || r.last_failure_at > r.last_success_at);

/** Last success and last failure of every cron hook and queue job kind that has run. */
export async function checkHooks(ctx: ServiceContext): Promise<Draft> {
  const base = { id: 'hooks', kind: 'cron', label: 'Cron and queue hooks' } as const;
  let rows: HookHealthRow[];
  try {
    rows = await listHookHealth(ctx.env.DB);
  } catch (error) {
    ctx.log.warn('status.probe_failed', { component: 'hooks', code: 'PROBE_FAILED', error });
    return { ...base, state: 'failing', detail: 'Probe failed.' };
  }
  if (rows.length === 0) return { ...base, state: 'configured', detail: 'No run recorded.' };
  const bad = rows.filter(failing);
  const data: Record<string, string | number> = { hooks: rows.length, failing: bad.length };
  for (const r of rows)
    data[`${r.kind}:${r.hook}`] =
      `ok ${iso(r.last_success_at)}, failed ${iso(r.last_failure_at)}${r.last_failure_code ? ` ${r.last_failure_code}` : ''}`;
  return {
    ...base,
    state: bad.length > 0 ? 'degraded' : 'verified',
    detail: bad.length > 0 ? `${bad.length} failing: ${bad.map((r) => r.hook).join(', ')}.` : null,
    data,
  };
}
