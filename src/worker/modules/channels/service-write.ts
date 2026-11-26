import type { z } from 'zod';
import { anyDigitalOn, DIGITAL_CHANNELS } from '../../../shared/channels.ts';
import {
  type BulkPassChannelsResponseSchema,
  type BulkPassChannelsSchema,
  CHANNELS,
  type Channel,
  type PassChannelState,
  type PutPassChannelsSchema,
} from '../../../shared/contracts/channels.ts';
import { bump, read } from '../../platform/counters.ts';
import { RateLimitedError } from '../../platform/errors.ts';
import type { ServiceContext } from '../../platform/service-context.ts';
import { recordPassEvents } from '../events/record.ts';
import type { TenantPassWrite } from '../passes/http.ts';
import { assertNewCodeAllowed, countNewCode } from '../passes/new-code.ts';
import type { Pass } from '../passes/repo-map.ts';
import { getPass } from '../passes/repo-read-pass.ts';
import type { Actor } from '../passes/service.ts';
import { activePrint } from '../prints/repo.ts';
import { adminWriter, writeVoid } from '../prints/repo-write.ts';
import { queueCodeReplacements } from './code-operation.ts';
import { planPass, previewBulk } from './plan.ts';
import {
  assertNoOpenWindow,
  noticeHolder,
  refuseAllOff,
  refuseUnsupported,
  rotateCode,
} from './replace.ts';
import { passReplaceable } from './replaceable.ts';
import { writePassChannels } from './repo-write.ts';
import { passChannels } from './service.ts';
import { openWindows } from './windows.ts';

type PutPass = z.infer<typeof PutPassChannelsSchema>;
type Bulk = z.infer<typeof BulkPassChannelsSchema>;
type BulkResponse = z.infer<typeof BulkPassChannelsResponseSchema>;

const HOUR = 3_600_000;
/** Override changes one pass may make per hour (the same window as New code). */
export const OVERRIDE_CHANGES_PER_HOUR = 20;

/** Sets or clears a pass's overrides; effective changes are audited and journaled. */
export async function putPassChannels(
  ctx: ServiceContext,
  actor: Actor,
  authority: TenantPassWrite,
  pass: Pass,
  body: PutPass,
) {
  const now = ctx.clock.now();
  const window = now - (now % HOUR);
  const key = `channels:override:${pass.id}`;
  if ((await read(ctx.env.DB, key, window)) >= OVERRIDE_CHANGES_PER_HOUR)
    throw new RateLimitedError(Math.ceil((window + HOUR - now) / 1000));

  const { inputs, rows, before, after, overrides, actions, rotates, owed } = await planPass(
    ctx,
    pass,
    body,
  );
  if (body.replaceCodes) {
    const touchesDigital = (Object.keys(body.channels) as Channel[]).some((c) =>
      DIGITAL_CHANNELS.includes(c),
    );
    if (touchesDigital && !anyDigitalOn(after)) refuseAllOff();
  }
  // Refused before anything is written: the pass would be off with its old code still working.
  if (owed) {
    if (!(await passReplaceable(ctx, pass))) refuseUnsupported();
    assertNoOpenWindow(await openWindows(ctx, pass.orgId, pass.mode, pass.templateId, now, 1));
    await assertNewCodeAllowed(ctx, pass.id);
  }

  const touched = new Set<Channel>(Object.keys(body.channels) as Channel[]);
  const retired = { ...rows.retired };
  const cause = { ...rows.retiredCause };
  for (const a of actions) {
    if (a.kind === 'retire') {
      touched.add(a.channel);
      retired[a.channel] = now;
      const source = after[a.channel].source;
      if (source === 'pass' || source === 'template') cause[a.channel] = source;
    } else if (a.kind === 'restore') {
      touched.add(a.channel);
      delete retired[a.channel];
      delete cause[a.channel];
    }
  }
  const changes = CHANNELS.filter((c) => before[c].on !== after[c].on).map((channel) => ({
    channel,
    from: before[channel].on ? 'on' : 'off',
    to: after[channel].on ? 'on' : 'off',
    source: after[channel].source,
  }));
  // Audit every override change too (a pin against later template changes); journal effective ones only.
  const audits: Record<string, unknown>[] = CHANNELS.flatMap((channel) => {
    const was = inputs.pass[channel] ?? null;
    const now = overrides[channel] ?? null;
    const effective = changes.find((c) => c.channel === channel);
    if (!effective && was === now) return [];
    return [
      {
        channel,
        from: before[channel].on ? 'on' : 'off',
        to: after[channel].on ? 'on' : 'off',
        source: after[channel].source,
        ...(was === now ? {} : { override: { from: was, to: now } }),
        ...(rotates ? { codesReplaced: true } : {}),
      },
    ];
  });
  await writePassChannels(
    ctx,
    authority,
    actor,
    pass,
    actor.id ?? actor.type,
    [...touched].map((channel) => ({
      channel,
      override: overrides[channel] ?? null,
      retiredAt: retired[channel] ?? null,
      retiredCause: cause[channel] ?? null,
    })),
    audits,
  );
  if (actions.some((a) => a.kind === 'void_prints') && (await activePrint(ctx.env.DB, pass.id)))
    await writeVoid(ctx, adminWriter(authority, actor), pass.id, 'channel_off');
  await bump(ctx.env.DB, key, window);
  // A flip, or a row newer than the pass (an earlier bump was lost), queues the republish.
  const pending = (rows.setAt.apple ?? 0) > pass.modifiedAt;
  if (before.apple.on !== after.apple.on || pending) {
    // Read after the commit: any publish from here on covers the change, so the job may skip.
    const current = await getPass(ctx.env.DB, pass.id);
    await ctx.env.JOBS.send({
      kind: 'channel.apple_bump',
      passId: pass.id,
      version: current?.version ?? pass.version,
    });
  }
  await recordPassEvents(
    ctx,
    changes.map((data) => ({
      orgId: pass.orgId,
      passId: pass.id,
      mode: pass.mode,
      kind: 'pass.channels_changed' as const,
      actor: { type: actor.type, id: actor.id },
      data,
    })),
  );
  if (owed) {
    // A system actor id, not the user's: a replace keeps the pass's print (the 0115 trigger reads the prefix).
    // The user is on the channel audit rows above.
    const done = await rotateCode(
      ctx,
      pass.id,
      `channel_replace:${ctx.requestId ?? ctx.ids.id()}`,
      authority,
    );
    if (done === 'rotated') await countNewCode(ctx, pass.id);
  }
  // Queued for any pass whose code was replaced since its channel went off: the mail job sends it once,
  // so a retry after a crash between the rotation and this line still tells the holder.
  if (rotates) await noticeHolder(ctx, pass.id);
  const stopped = actions.flatMap((a) =>
    a.kind === 'retire' && rows.copies.includes(a.channel) && DIGITAL_CHANNELS.includes(a.channel)
      ? [a.channel]
      : [],
  );
  // A copy stopped working: the holder is told, unless a new code's notice already said so.
  if (body.notify && !rotates && stopped.length > 0)
    await ctx.env.JOBS.send({
      kind: 'pass.holder_mail',
      passId: pass.id,
      userId: null,
      reason: 'channel_off',
      channels: stopped.filter((c) => c !== 'paper' && c !== 'nfc') as (
        | 'mobile'
        | 'apple'
        | 'google'
        | 'samsung'
      )[],
    });
  return passChannels(ctx, pass);
}

/** Many passes, one org and mode: on or off sets the override, reset clears it. */
export async function bulkPassChannels(
  ctx: ServiceContext,
  actor: Actor,
  authority: TenantPassWrite,
  passes: Pass[],
  body: Bulk,
  /** Who asks, for the operation that shows the code replacements. */
  starter?: { type: 'user' | 'api_key' | 'system'; id: string | null },
): Promise<BulkResponse> {
  const value: PassChannelState | null = body.action === 'reset' ? null : body.action;
  const channels = Object.fromEntries(body.channels.map((c) => [c, value]));
  if (body.dryRun) return previewBulk(ctx, passes, body, channels);
  const out: BulkResponse = { done: 0, skipped: [], operationId: null };
  const bulkKey = ctx.requestId ?? ctx.ids.id();
  const replaced: string[] = [];
  let failure: unknown = null;
  try {
    for (const pass of passes) {
      try {
        await putPassChannels(ctx, actor, authority, pass, {
          channels,
          notify: body.notify,
          replaceCodes: false,
        });
        // The overrides are in; the new code waits for its windows in one job per pass.
        if (body.replaceCodes && value === 'off') replaced.push(pass.id);
        out.done += 1;
      } catch (error) {
        if (!(error instanceof RateLimitedError)) throw error;
        out.skipped.push({ id: pass.id, code: 'RATE_LIMITED' });
      }
    }
  } catch (error) {
    failure = error;
  }
  // The overrides that were written get their replacement jobs even when a later pass failed, and the loop's own
  // error is the one that comes back.
  out.operationId = await queueCodeReplacements(ctx, authority, starter, {
    passIds: replaced,
    key: `channel_bulk:${bulkKey}`,
    updated: out.done,
  });
  if (failure) throw failure;
  return out;
}
