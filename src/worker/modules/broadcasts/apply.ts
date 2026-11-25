import { ZodError } from 'zod';
import type { Json } from '../../../shared/contracts/common.ts';
import { AppError, ConflictError } from '../../platform/errors.ts';
import type { ServiceContext } from '../../platform/service-context.ts';
import { dispatchSafely } from '../delivery/issuance-intent.ts';
import { recordPassEvent } from '../events/record.ts';
import { addRuleCounts, claimFire, releaseFire } from '../message-rules/repo-window.ts';
import { resolveTemplate } from '../passes/builder.ts';
import { pushBudgetOf } from '../passes/change-messages.ts';
import { publishPass } from '../passes/publish.ts';
import type { Pass } from '../passes/repo.ts';
import { getPass } from '../passes/repo-read-pass.ts';
import { readOrgTimeZone } from '../scan/repo-org-clock.ts';
import { budgetOutcomes, providerBudgets } from '../wallet-providers/notify-budget.ts';
import { actorOf } from './actor.ts';
import type { DesignCache } from './apply-action.ts';
import { applyChange, type ChangePlan, type FieldCache, planOf } from './apply-change.ts';
import { endIfRevoked, revertChunk } from './apply-revert.ts';
import { settlePending } from './change-intent.ts';
import {
  type BroadcastRow,
  casState,
  getBroadcast,
  handledPassIds,
  type ItemRow,
  insertItems,
} from './repo.ts';
import { creatorLive } from './repo-creator.ts';
import { hasVersionFrom } from './repo-items.ts';
import { targetPage } from './repo-target.ts';
import { StoredBroadcastTargetSchema } from './stored-target.ts';

/**
 * Passes per workflow step. A pass costs up to ~30 D1 queries (read, build, publish, events,
 * item); a step may spend 1,000, so 25 passes leave room for the page and chunk reads.
 */
export const CHUNK = 25;

export { actorOf };

/** Which input a template's message goes to; null when it has no message field. */
type MessagingInputs = Map<string, string | null>;

async function messagingInput(
  ctx: ServiceContext,
  cache: MessagingInputs,
  pass: Pass,
): Promise<string | null> {
  const key = `${pass.templateId}@${pass.templateVersion}`;
  if (cache.has(key)) return cache.get(key) ?? null;
  const template = await resolveTemplate(ctx, pass.orgId, pass.templateId, pass.templateVersion);
  const input = template.manifest.messaging?.input ?? null;
  cache.set(key, input);
  return input;
}

/** Notifying updates a pass may get a day from all automatic messages, plus one slot kept free. */
export const RULE_BUDGET_CAP = 3;

/** The rule and window of an automatic message's own run; its clearing follow-up has neither. */
function ruleRun(row: BroadcastRow) {
  if (!row.rule_id || row.parent_id !== null) return null;
  const { window } = StoredBroadcastTargetSchema.parse(JSON.parse(row.target));
  return window ? { ruleId: row.rule_id, window } : null;
}

/** Applies the broadcast to one pass. Never throws for a pass-level problem. */
async function applyOne(
  ctx: ServiceContext,
  row: BroadcastRow,
  cache: MessagingInputs,
  passId: string,
  change: { plan: ChangePlan; fields: FieldCache; designs: DesignCache },
): Promise<ItemRow | 'deferred' | null> {
  const base = { passId, silent: false };
  const rule = ruleRun(row);
  const pass = await getPass(ctx.env.DB, passId, row.org_id);
  if (
    !pass ||
    pass.orgId !== row.org_id ||
    pass.mode !== row.mode ||
    pass.status !== 'active' ||
    pass.removedAt !== null
  )
    return null;
  if (row.kind === 'change')
    return applyChange(ctx, row, change.plan, change.fields, pass, change.designs);
  let claimed = false;
  try {
    const patch = JSON.parse(row.patch) as Record<string, Json>;
    const values: Record<string, Json> = {};
    const expected = row.expect ? (JSON.parse(row.expect) as Record<string, Json>) : null;
    const input = await messagingInput(ctx, cache, pass);
    if (!input) {
      ctx.log.warn('broadcast.no_message_field', {
        broadcastId: row.id,
        templateId: pass.templateId,
        code: 'MESSAGING_UNSUPPORTED',
      });
      return { ...base, outcome: 'failed' };
    }
    values[input] = patch.message ?? '';
    if (expected && pass.personalization[input] !== expected.message)
      return { ...base, outcome: 'unchanged' };
    if (rule) {
      // One notifying slot a day stays free for operational updates; a pass at the rule limit waits
      // for a later check inside the window and is never sent silently.
      const budget = await pushBudgetOf(ctx, passId);
      const slots = Math.min(budget.limit, RULE_BUDGET_CAP) - 1;
      if (budget.used >= slots) return 'deferred';
      const claim = await claimFire(ctx.env.DB, {
        ruleId: rule.ruleId,
        broadcastId: row.id,
        passId,
        orgId: row.org_id,
        mode: row.mode,
        window: rule.window,
        now: ctx.clock.now(),
        slots,
      });
      if (claim === 'full') return 'deferred';
      claimed = claim === 'claimed';
      if (!claimed) return { ...base, outcome: 'unchanged' };
    }
    const clearing = String(patch.message ?? '').trim() === '';
    const notify = row.notify === 1 && !clearing;
    const result = await publishPass(ctx, {
      passId,
      orgScope: row.org_id,
      cause: row.created_by_type === 'api_key' ? 'api' : 'admin',
      source: 'broadcast',
      actor: actorOf(row),
      dispatch: false,
      notify,
      extraChecks: [creatorLive(row, ctx.clock.now())],
      mutate: (current) => {
        // A pass may have changed since selection. publishPass reruns this check on each retry,
        // and its CAS commits only against the same org, mode, status and removal snapshot.
        if (
          current.orgId !== row.org_id ||
          current.mode !== row.mode ||
          current.status !== 'active' ||
          current.removedAt !== null
        )
          throw new ConflictError('Pass no longer matches the broadcast.', 'PASS_CONFLICT');
        return { personalization: { ...current.personalization, ...values } };
      },
    });
    if (!result.changed) {
      // A run that died after publishing leaves the new version but no item: count it once.
      const written = await hasVersionFrom(ctx.env.DB, passId, 'broadcast', row.started_at ?? 0);
      return { ...base, outcome: written ? 'updated' : 'unchanged' };
    }
    // Google and Samsung copies have their own limits, apart from Apple's; nothing is sent to them yet.
    const providers =
      notify && !result.silenced ? budgetOutcomes(await providerBudgets(ctx, result.pass)) : null;
    await recordPassEvent(ctx, {
      orgId: row.org_id,
      passId,
      mode: row.mode,
      kind: 'message.applied',
      actor: actorOf(row),
      data: {
        broadcastId: row.id,
        notified: notify && !result.silenced,
        overBudget: !!result.silenced,
        ...(providers ? { providers } : {}),
      },
    });
    return { ...base, outcome: 'updated', silent: !!result.silenced };
  } catch (error) {
    // A crash after the claim loses one reminder and never doubles it: only an AppError releases it.
    if (!(error instanceof AppError)) throw error;
    if (claimed && rule) await releaseFire(ctx.env.DB, rule.ruleId, passId, row.id);
    ctx.log.warn('broadcast.pass_failed', { broadcastId: row.id, passId, code: error.code });
    return { ...base, outcome: 'failed' };
  }
}

export async function failInvalidTarget(ctx: ServiceContext, row: BroadcastRow): Promise<void> {
  ctx.log.warn('broadcast.blocked', { broadcastId: row.id, code: 'BROADCAST_TARGET_INVALID' });
  await casState(ctx.env.DB, row.id, ['sending'], 'failed', {
    finishedAt: ctx.clock.now(),
    errorCode: 'BROADCAST_TARGET_INVALID',
  });
}

export function targetFilter(
  row: Pick<BroadcastRow, 'org_id' | 'mode' | 'target'> & {
    id?: string;
    rule_id?: string | null;
    kind?: string;
  },
  cursor: string | null,
  limit: number,
  /** Read the target's own filters, not the run's snapshot (the start that takes the snapshot). */
  live = false,
) {
  const target = StoredBroadcastTargetSchema.parse(JSON.parse(row.target));
  // A change run acts on the passes snapshotted for it; what it matched is fixed once it starts.
  if (!live && row.kind === 'change' && row.id && !target.revertOf)
    return {
      orgId: row.org_id,
      mode: row.mode,
      snapshot: row.id,
      ...(cursor ? { cursor } : {}),
      limit,
    };
  return {
    orgId: row.org_id,
    mode: row.mode,
    templateIds: target.templateIds,
    ...(target.onDevice !== undefined ? { onDevice: target.onDevice } : {}),
    ...(target.holderState ? { holderState: target.holderState } : {}),
    ...(target.q ? { q: target.q } : {}),
    ...(target.scan ? { scan: target.scan } : {}),
    ...(target.match ? { match: target.match } : {}),
    ...(target.version ? { version: target.version } : {}),
    ...(target.window ? { window: target.window, ruleId: row.rule_id ?? '' } : {}),
    ...(target.sentBy ? { sentBy: target.sentBy } : {}),
    ...(target.passIds ? { passIds: target.passIds } : {}),
    ...(target.importId ? { importId: target.importId } : {}),
    ...(row.id ? { broadcastId: row.id } : {}),
    ...(cursor ? { cursor } : {}),
    limit,
  };
}

/**
 * `targetFilter`, or null when the stored target no longer parses (a time zone that left the tz
 * database): the caller ends the run with `BROADCAST_TARGET_INVALID` instead of throwing forever.
 */
export function safeTargetFilter(
  row: Parameters<typeof targetFilter>[0],
  cursor: string | null,
  limit: number,
  live = false,
): ReturnType<typeof targetFilter> | null {
  try {
    return targetFilter(row, cursor, limit, live);
  } catch (error) {
    if (error instanceof ZodError || error instanceof RangeError) return null;
    throw error;
  }
}

/** One chunk of up to `CHUNK` passes. A pass that already has an outcome is skipped on retry. */
export async function applyChunk(
  ctx: ServiceContext,
  broadcastId: string,
  cursor: string | null,
  chunk = CHUNK,
): Promise<{ nextCursor: string | null }> {
  const row = await getBroadcast(ctx.env.DB, broadcastId, null);
  if (row?.state !== 'sending') return { nextCursor: null };
  const filter = safeTargetFilter(row, cursor, chunk);
  if (!filter) {
    await failInvalidTarget(ctx, row);
    return { nextCursor: null };
  }
  const stored = StoredBroadcastTargetSchema.parse(JSON.parse(row.target));
  if (stored.revertOf) return revertChunk(ctx, row, stored.revertOf, cursor);
  if (row.kind === 'change') await settlePending(ctx, row);
  const page = await targetPage(ctx.env.DB, filter, ctx.clock.now());
  const done = await handledPassIds(ctx.env.DB, broadcastId, page.ids);
  const cache: MessagingInputs = new Map();
  const change = {
    plan: planOf(row, await readOrgTimeZone(ctx.env.DB, row.org_id)),
    fields: new Map() as FieldCache,
    designs: new Map() as DesignCache,
  };
  let updated = 0;
  let deferred = 0;
  for (const passId of page.ids) {
    if (done.has(passId)) continue;
    const item = await applyOne(ctx, row, cache, passId, change);
    if (item === 'deferred') {
      deferred++;
      continue;
    }
    if (!item) continue;
    if (item.outcome === 'failed' && row.kind === 'change' && (await endIfRevoked(ctx, row)))
      return { nextCursor: null };
    await insertItems(ctx.env.DB, broadcastId, [item]);
    if (item.outcome === 'updated') updated++;
  }
  if (row.rule_id && (updated > 0 || deferred > 0)) {
    await addRuleCounts(ctx.env.DB, row.rule_id, updated, deferred);
    if (deferred > 0)
      ctx.log.info('message_rule.deferred', { ruleId: row.rule_id, orgId: row.org_id, deferred });
  }
  if (updated > 0) await dispatchSafely(ctx);
  return { nextCursor: page.nextCursor };
}
