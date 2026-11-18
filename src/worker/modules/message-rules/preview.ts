import type { z } from 'zod';
import type { InputMatch } from '../../../shared/contracts/broadcasts.ts';
import type { Mode } from '../../../shared/contracts/common.ts';
import type { RulePreviewBodySchema } from '../../../shared/contracts/message-rules.ts';
import { addDays, dayRange, localDate, zonedInstant } from '../../../shared/zoned.ts';
import { batch } from '../../platform/db.ts';
import type { ServiceContext } from '../../platform/service-context.ts';
import { RULE_BUDGET_CAP, targetFilter } from '../broadcasts/apply.ts';
import { countTarget, countTargetedStmt } from '../broadcasts/repo-target.ts';
import { getPlatformSettings } from '../settings/service.ts';
import { checkRuleTemplates } from './validate.ts';
import { type RuleWindow, ruleWindow } from './windows.ts';

const DAYS = 14;
type Body = z.infer<typeof RulePreviewBodySchema>;

/** The window a run would target for local day `day`: the passes whose reminder is due that day. */
function windowFor(body: Body, kind: Parameters<typeof ruleWindow>[1], day: string): RuleWindow {
  const { offset, anchor, timeZone } = body;
  if (offset.unit === 'hour' && anchor.kind === 'input') {
    // The due time moves by real hours: anchors in [day start, next day start) shifted by the offset.
    const [start, end] = dayRange(day, timeZone);
    const shift = offset.amount * 3_600_000 * (offset.when === 'before' ? 1 : -1);
    return {
      kind: 'dateTime',
      input: anchor.input,
      fromMs: start + shift,
      toMs: end + shift,
      inclusiveEnd: false,
      occurrence: 'anchor',
    };
  }
  return ruleWindow(body, kind, zonedInstant(day, body.sendAt, timeZone));
}

/** Passes due on each of the next 14 days: one batch of counts, plus today's at-limit figure. */
export async function previewRule(ctx: ServiceContext, mode: Mode, body: Body) {
  const kind = await checkRuleTemplates(
    ctx,
    body.orgId,
    body.templateIds,
    body.anchor,
    body.offset,
  );
  const now = ctx.clock.now();
  const today = localDate(now, body.timeZone);
  const days = Array.from({ length: DAYS }, (_, i) => addDays(today, i));
  const base = (window: RuleWindow) =>
    targetFilter(
      {
        org_id: body.orgId,
        mode,
        target: JSON.stringify({
          templateIds: body.templateIds,
          ...(body.match ? { match: body.match as InputMatch } : {}),
          window,
        }),
        rule_id: body.ruleId ?? null,
      },
      null,
      1,
    );
  const windows = days.map((d) => windowFor(body, kind, d));
  const results = await batch(
    ctx.env.DB,
    windows.map((w) => countTargetedStmt(ctx.env.DB, base(w), now)),
  );
  const counts = results.map((r) => Number((r.results[0] as { n?: number } | undefined)?.n ?? 0));
  const limit = (await getPlatformSettings(ctx))['push.budgetPerDay'];
  const first = windows[0];
  const atLimit = first
    ? (
        await countTarget(
          ctx.env.DB,
          base(first),
          now,
          now - 86_400_000,
          Math.min(limit, RULE_BUDGET_CAP) - 1,
        )
      ).overBudget
    : 0;
  return {
    days: days.map((date, i) => ({ date, count: counts[i] ?? 0 })),
    total: counts.reduce((a, b) => a + b, 0),
    atLimit,
  };
}
