import { FIELD_GROUPS } from '../../../passkit/schema/constants.ts';
import { PASS_STYLES, type PassJson } from '../../../passkit/types.ts';
import type { PushBudgetDto } from '../../../shared/contracts/passes.ts';
import type { ServiceContext } from '../../platform/service-context.ts';
import { getPlatformSettings } from '../settings/service.ts';
import { notifiedSince } from './repo-budget.ts';

type Field = { key?: unknown; value?: unknown; changeMessage?: unknown };

function fieldsOf(pass: PassJson): Map<string, Field> {
  const out = new Map<string, Field>();
  for (const style of PASS_STYLES) {
    const dict = (pass as Record<string, unknown>)[style];
    if (!dict || typeof dict !== 'object') continue;
    for (const group of FIELD_GROUPS) {
      const list = (dict as Record<string, unknown>)[group];
      if (!Array.isArray(list)) continue;
      for (const f of list as Field[])
        if (f && typeof f === 'object' && typeof f.key === 'string') out.set(f.key, f);
    }
  }
  return out;
}

/**
 * An editor's save. Without `notify` every changeMessage goes; with it, a field keeps (or gets
 * "%@") its message only when its value differs from the previous version. Returns true when the
 * pass changed. Wallet only shows a message for a changed value, so syncs keep the template's.
 */
export function applyChangeMessages(
  pass: PassJson,
  previous: PassJson | null,
  notify: boolean,
): boolean {
  const before = previous ? fieldsOf(previous) : new Map<string, Field>();
  let changed = false;
  for (const [key, field] of fieldsOf(pass)) {
    const moved = notify && JSON.stringify(before.get(key)?.value) !== JSON.stringify(field.value);
    if (moved) {
      if (typeof field.changeMessage !== 'string') {
        field.changeMessage = '%@';
        changed = true;
      }
    } else if (field.changeMessage !== undefined) {
      delete field.changeMessage;
      changed = true;
    }
  }
  return changed;
}

/**
 * True when publishing `pass` over `previous` can show a lock-screen message: a field with a
 * changeMessage whose value changed. A first version never notifies.
 */
export function notifiesHolder(pass: PassJson, previous: PassJson | null): boolean {
  if (!previous) return false;
  const before = fieldsOf(previous);
  for (const [key, field] of fieldsOf(pass))
    if (
      typeof field.changeMessage === 'string' &&
      JSON.stringify(before.get(key)?.value) !== JSON.stringify(field.value)
    )
      return true;
  return false;
}

/** Removes every changeMessage so the update reaches the device without a notification. */
export function stripChangeMessages(pass: PassJson): boolean {
  let changed = false;
  for (const field of fieldsOf(pass).values())
    if (field.changeMessage !== undefined) {
      delete field.changeMessage;
      changed = true;
    }
  return changed;
}

export const BUDGET_WINDOW_MS = 24 * 3_600_000;

/**
 * Notifying updates this pass got in the last 24 hours against `push.budgetPerDay`. Every
 * publish source counts the same: edits, syncs, upgrades, scans, broadcasts and schedules.
 */
export async function pushBudgetOf(ctx: ServiceContext, passId: string): Promise<PushBudgetDto> {
  const [{ used, oldest }, settings] = await Promise.all([
    notifiedSince(ctx.env.DB, passId, ctx.clock.now() - BUDGET_WINDOW_MS),
    getPlatformSettings(ctx),
  ]);
  return {
    used,
    limit: settings['push.budgetPerDay'],
    resetsAt: oldest === null ? null : oldest + BUDGET_WINDOW_MS,
  };
}

export const overBudget = (budget: PushBudgetDto): boolean => budget.used >= budget.limit;
