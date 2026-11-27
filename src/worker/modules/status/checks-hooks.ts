import type { ServiceContext } from '../../platform/service-context.ts';
import { type HookHealthRow, type HookKind, listHookHealth } from './repo-hooks.ts';

const iso = (at: number | null) => (at === null ? 'never' : new Date(at).toISOString());

/** A hook is failing when its last run failed: the failure is newer than the last success. */
const failing = (r: HookHealthRow) =>
  r.last_failure_at !== null &&
  (r.last_success_at === null || r.last_failure_at > r.last_success_at);

/** Every recorded hook; a failed read is logged and shows no hooks rather than failing the row. */
export async function loadHooks(ctx: ServiceContext): Promise<HookHealthRow[]> {
  try {
    return await listHookHealth(ctx.env.DB);
  } catch (error) {
    ctx.log.warn('status.probe_failed', { component: 'hooks', code: 'PROBE_FAILED', error });
    return [];
  }
}

/** Adds each hook's last success and failure to a row's detail; a failing hook degrades the row. */
export function withHooks<
  T extends {
    state: string;
    detail: string | null;
    data?: Record<string, string | number | boolean | null> | undefined;
  },
>(draft: T, rows: HookHealthRow[], kind: HookKind): T {
  const mine = rows.filter((r) => r.kind === kind);
  if (mine.length === 0) return draft;
  const data: Record<string, string | number | boolean | null> = { ...draft.data };
  for (const r of mine)
    data[r.hook] =
      `ok ${iso(r.last_success_at)}, failed ${iso(r.last_failure_at)}${r.last_failure_code ? ` ${r.last_failure_code}` : ''}`;
  const bad = mine.filter(failing);
  if (bad.length === 0) return { ...draft, data };
  const note = `${bad.length} failing: ${bad.map((r) => r.hook).join(', ')}.`;
  return {
    ...draft,
    state: draft.state === 'failing' ? 'failing' : 'degraded',
    detail: draft.detail ? `${draft.detail} ${note}` : note,
    data,
  };
}
