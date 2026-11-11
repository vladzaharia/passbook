import { BroadcastTargetSchema } from '../../../shared/contracts/broadcasts.ts';
import type { Json } from '../../../shared/contracts/common.ts';
import { AppError, ConflictError } from '../../platform/errors.ts';
import type { ServiceContext } from '../../platform/service-context.ts';
import { dispatchSafely } from '../delivery/issuance-intent.ts';
import { recordPassEvent } from '../events/record.ts';
import { resolveTemplate } from '../passes/builder.ts';
import { publishPass } from '../passes/publish.ts';
import type { Pass } from '../passes/repo.ts';
import { getPass } from '../passes/repo-read-pass.ts';
import type { Actor } from '../passes/service.ts';
import {
  type BroadcastRow,
  getBroadcast,
  handledPassIds,
  type ItemRow,
  insertItems,
} from './repo.ts';
import { hasVersionFrom } from './repo-items.ts';
import { targetPage } from './repo-target.ts';

/**
 * Passes per workflow step. A pass costs up to ~30 D1 queries (read, build, publish, events,
 * item); a step may spend 1,000, so 25 passes leave room for the page and chunk reads.
 */
export const CHUNK = 25;

const ACTOR_TYPES = ['user', 'api_key', 'system', 'connection'] as const;

export function actorOf(row: Pick<BroadcastRow, 'created_by_type' | 'created_by_id'>): Actor {
  const type = ACTOR_TYPES.find((t) => t === row.created_by_type) ?? 'system';
  return { type, id: row.created_by_id };
}

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

/** Applies the broadcast to one pass. Never throws for a pass-level problem. */
async function applyOne(
  ctx: ServiceContext,
  row: BroadcastRow,
  cache: MessagingInputs,
  passId: string,
): Promise<ItemRow | null> {
  const base = { passId, silent: false };
  const pass = await getPass(ctx.env.DB, passId, row.org_id);
  if (
    !pass ||
    pass.orgId !== row.org_id ||
    pass.mode !== row.mode ||
    pass.status !== 'active' ||
    pass.removedAt !== null
  )
    return null;
  try {
    const patch = JSON.parse(row.patch) as Record<string, Json>;
    const values: Record<string, Json> = {};
    const expected = row.expect ? (JSON.parse(row.expect) as Record<string, Json>) : null;
    if (row.kind === 'message') {
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
    } else Object.assign(values, patch);
    const clearing = row.kind === 'message' && String(patch.message ?? '').trim() === '';
    const notify = row.notify === 1 && !clearing;
    const result = await publishPass(ctx, {
      passId,
      orgScope: row.org_id,
      cause: row.created_by_type === 'api_key' ? 'api' : 'admin',
      source: row.kind === 'message' ? 'broadcast' : 'schedule',
      actor: actorOf(row),
      dispatch: false,
      notify,
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
      const source = row.kind === 'message' ? 'broadcast' : 'schedule';
      const written = await hasVersionFrom(ctx.env.DB, passId, source, row.started_at ?? 0);
      return { ...base, outcome: written ? 'updated' : 'unchanged' };
    }
    await recordPassEvent(ctx, {
      orgId: row.org_id,
      passId,
      mode: row.mode,
      kind: row.kind === 'message' ? 'message.applied' : 'schedule.applied',
      actor: actorOf(row),
      data: {
        broadcastId: row.id,
        notified: notify && !result.silenced,
        overBudget: !!result.silenced,
      },
    });
    return { ...base, outcome: 'updated', silent: !!result.silenced };
  } catch (error) {
    if (!(error instanceof AppError)) throw error;
    ctx.log.warn('broadcast.pass_failed', { broadcastId: row.id, passId, code: error.code });
    return { ...base, outcome: 'failed' };
  }
}

export function targetFilter(
  row: Pick<BroadcastRow, 'org_id' | 'mode' | 'target'>,
  cursor: string | null,
  limit: number,
) {
  const target = BroadcastTargetSchema.parse(JSON.parse(row.target));
  return {
    orgId: row.org_id,
    mode: row.mode,
    templateIds: target.templateIds,
    ...(target.onDevice !== undefined ? { onDevice: target.onDevice } : {}),
    ...(target.holderState ? { holderState: target.holderState } : {}),
    ...(target.q ? { q: target.q } : {}),
    ...(target.scan ? { scan: target.scan } : {}),
    ...(cursor ? { cursor } : {}),
    limit,
  };
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
  const page = await targetPage(ctx.env.DB, targetFilter(row, cursor, chunk), ctx.clock.now());
  const done = await handledPassIds(ctx.env.DB, broadcastId, page.ids);
  const cache: MessagingInputs = new Map();
  let updated = 0;
  for (const passId of page.ids) {
    if (done.has(passId)) continue;
    const item = await applyOne(ctx, row, cache, passId);
    if (!item) continue;
    await insertItems(ctx.env.DB, broadcastId, [item]);
    if (item.outcome === 'updated') updated++;
  }
  if (updated > 0) await dispatchSafely(ctx);
  return { nextCursor: page.nextCursor };
}
