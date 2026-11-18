import type { InputMatch } from '../../../shared/contracts/broadcasts.ts';
import { jobGrant } from '../../platform/authority.ts';
import { AppError } from '../../platform/errors.ts';
import type { ServiceContext } from '../../platform/service-context.ts';
import { safeTargetFilter } from '../broadcasts/apply.ts';
import { insertRuleRunStmt } from '../broadcasts/repo.ts';
import { creatorLive } from '../broadcasts/repo-creator.ts';
import { countTargeted } from '../broadcasts/repo-target.ts';
import {
  getRule,
  pauseWithCode,
  type RuleRow,
  runByWindow,
  runningRuleBroadcasts,
  setNextCheck,
} from './repo.ts';
import { LEASE_MS } from './tick.ts';
import { checkRuleTemplates } from './validate.ts';
import { HOUR_CHECK_MS, nextCheckAt, type RuleTiming, ruleWindow, sendDayOpen } from './windows.ts';

const ORG_RUNNING_CAP = 3;
const PLATFORM_RUNNING_CAP = 15;
const DEFER_MS = 10 * 60_000;

const timingOf = (row: RuleRow): RuleTiming => ({
  anchor:
    row.anchor_kind === 'input'
      ? { kind: 'input', input: row.anchor_input ?? '' }
      : { kind: 'lastScan' },
  offset: { amount: row.offset_amount, unit: row.offset_unit, when: row.offset_when },
  yearly: row.yearly === 1,
  sendAt: row.send_at,
  timeZone: row.time_zone,
});

/** The rule runs as its last saver: false (and the rule paused) when that person or key lost access. */
async function allowed(ctx: ServiceContext, row: RuleRow): Promise<boolean> {
  const now = ctx.clock.now();
  try {
    await jobGrant(ctx, {
      purpose: 'org_mode.job.message_rule.check',
      job: 'message_rule',
      orgId: row.org_id,
      mode: row.mode,
      target: row.id,
      checks: [
        creatorLive(
          {
            created_by_type: row.created_by_type,
            created_by_id: row.created_by_id,
            created_at: row.edited_at,
            kind: 'message',
            mode: row.mode,
          },
          now,
        ),
      ],
    }).commit();
    return true;
  } catch (error) {
    if (!(error instanceof AppError) || error.status >= 500) throw error;
    const code = error.code === 'ORG_ACCESS_CHANGED' ? 'ORG_INACTIVE' : 'RULE_CREATOR_REVOKED';
    ctx.log.warn('message_rule.paused', { ruleId: row.id, orgId: row.org_id, code });
    await pauseWithCode(ctx.env.DB, row.id, code, now);
    return false;
  }
}

/**
 * One check of one rule: authority, templates, back-pressure, the due window. A window with
 * passes becomes an ordinary scheduled broadcast; `broadcasts.start` runs it.
 */
export async function checkRule(
  ctx: ServiceContext,
  job: { ruleId: string; at: number },
): Promise<void> {
  const db = ctx.env.DB;
  const now = ctx.clock.now();
  // A job redelivered after its lease would compute a stale window; the next tick makes a fresh one.
  if (now - job.at > LEASE_MS) {
    ctx.log.info('message_rule.stale_job', { ruleId: job.ruleId, code: 'RULE_JOB_STALE' });
    return;
  }
  const row = await getRule(db, job.ruleId, null);
  if (row?.state !== 'on') return;
  const version = row.version;
  const rule = timingOf(row);
  if (!(await allowed(ctx, row))) return;
  const templateIds = JSON.parse(row.template_ids) as string[];
  let kind: Awaited<ReturnType<typeof checkRuleTemplates>>;
  try {
    kind = await checkRuleTemplates(ctx, row.org_id, templateIds, rule.anchor, rule.offset);
  } catch (error) {
    if (!(error instanceof AppError) || error.status >= 500) throw error;
    ctx.log.warn('message_rule.paused', {
      ruleId: row.id,
      orgId: row.org_id,
      code: 'RULE_INPUT_MISSING',
    });
    await pauseWithCode(db, row.id, 'RULE_INPUT_MISSING', now);
    return;
  }
  // Day rules send only inside their day; a missed day stays unsent so the text is never wrong.
  if (rule.offset.unit === 'day' && !sendDayOpen(rule, job.at)) {
    await setNextCheck(db, row.id, version, Math.max(nextCheckAt(rule, now), now + 1000));
    return;
  }
  const running = await runningRuleBroadcasts(db, row.id, row.org_id, row.mode);
  if (
    (running?.own ?? 0) > 0 ||
    (running?.org ?? 0) >= ORG_RUNNING_CAP ||
    (running?.platform ?? 0) >= PLATFORM_RUNNING_CAP
  ) {
    ctx.log.info('message_rule.deferred', {
      ruleId: row.id,
      orgId: row.org_id,
      code: 'RULE_BACKPRESSURE',
    });
    await setNextCheck(
      db,
      row.id,
      version,
      now + (rule.offset.unit === 'hour' ? HOUR_CHECK_MS : DEFER_MS),
    );
    return;
  }
  const window = ruleWindow(rule, kind, job.at);
  const match = row.match ? (JSON.parse(row.match) as InputMatch) : undefined;
  const target = { templateIds, ...(match ? { match } : {}), window };
  const filter = safeTargetFilter(
    { id: '', org_id: row.org_id, mode: row.mode, target: JSON.stringify(target), rule_id: row.id },
    null,
    1,
  );
  if (!filter) {
    ctx.log.warn('message_rule.paused', {
      ruleId: row.id,
      orgId: row.org_id,
      code: 'RULE_TARGET_INVALID',
    });
    await pauseWithCode(db, row.id, 'RULE_TARGET_INVALID', now);
    return;
  }
  const targeted = await countTargeted(db, filter, now);
  let broadcastId: string | undefined;
  if (targeted > 0) {
    const inserted = await insertRuleRunStmt(
      db,
      {
        id: ctx.ids.id(),
        orgId: row.org_id,
        mode: row.mode,
        kind: 'message',
        name: row.name,
        state: 'scheduled',
        target,
        patch: { message: row.message },
        notify: true,
        at: now,
        clearAfter: row.clear_after,
        ruleId: row.id,
        windowKey: String(job.at),
        actor: { type: row.created_by_type ?? 'system', id: row.created_by_id },
        now,
      },
      { org: ORG_RUNNING_CAP, platform: PLATFORM_RUNNING_CAP },
    ).run();
    broadcastId = (await runByWindow(db, row.id, String(job.at)))?.id;
    if (!broadcastId && inserted.meta.changes === 0) {
      // Another rule took the last slot between the count above and the insert.
      ctx.log.info('message_rule.deferred', {
        ruleId: row.id,
        orgId: row.org_id,
        code: 'RULE_BACKPRESSURE',
      });
      await setNextCheck(
        db,
        row.id,
        version,
        now + (rule.offset.unit === 'hour' ? HOUR_CHECK_MS : DEFER_MS),
      );
      return;
    }
    ctx.log.info('message_rule.run_created', { ruleId: row.id, orgId: row.org_id, targeted });
  }
  await setNextCheck(db, row.id, version, nextCheckAt(rule, now), broadcastId);
}
