import { AppError } from '../../platform/errors.ts';
import type { ServiceContext } from '../../platform/service-context.ts';
import { type HookKind, hookHealthStmt } from './repo-hooks.ts';

export interface HookOutcome {
  hook: string;
  /** Null on success; a stable code on failure. */
  failure: string | null;
}

const STABLE_CODE = /^[A-Z][A-Z0-9_]{1,79}$/;

/** A stable code for a failure; an error's message is never kept. */
export function failureCode(error: unknown, fallback: string): string {
  return error instanceof AppError && STABLE_CODE.test(error.code) ? error.code : fallback;
}

/**
 * Keeps the last success and last failure per hook. One batch per run, so a cron run or a queue
 * batch costs one D1 round trip. A failed write is logged, never thrown: health must not fail the hook.
 */
export async function recordHookOutcomes(
  ctx: ServiceContext,
  kind: HookKind,
  outcomes: HookOutcome[],
): Promise<void> {
  if (outcomes.length === 0) return;
  const now = ctx.clock.now();
  const merged = new Map<string, { ok: boolean; code: string | null }>();
  for (const o of outcomes) {
    const prev = merged.get(o.hook);
    merged.set(o.hook, {
      ok: (prev?.ok ?? false) || o.failure === null,
      code: o.failure ?? prev?.code ?? null,
    });
  }
  const statements = [...merged].map(([hook, m]) =>
    hookHealthStmt(ctx.env.DB, kind, hook, m.ok ? now : null, m.code === null ? null : now, m.code),
  );
  try {
    await ctx.env.DB.batch(statements);
  } catch (error) {
    ctx.log.warn('hooks.record_failed', { kind, code: 'HOOK_HEALTH_RECORD_FAILED', error });
  }
}
