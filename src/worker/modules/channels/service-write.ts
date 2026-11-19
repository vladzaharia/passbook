import type { z } from 'zod';
import {
  anyDigitalOn,
  channelTransition,
  DIGITAL_CHANNELS,
  effectiveChannels,
} from '../../../shared/channels.ts';
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
import {
  assertNoOpenWindow,
  noticeHolder,
  refuseAllOff,
  refuseUnsupported,
  rotateCode,
} from './replace.ts';
import { passReplaceable } from './replaceable.ts';
import { writePassChannels } from './repo-write.ts';
import { loadPass, passChannels } from './service.ts';
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

  const { inputs, rows } = await loadPass(ctx, pass);
  const before = effectiveChannels(inputs);
  const overrides = { ...inputs.pass };
  for (const [c, v] of Object.entries(body.channels) as [Channel, PassChannelState | null][]) {
    if (v === null) delete overrides[c];
    else overrides[c] = v;
  }
  const after = effectiveChannels({ ...inputs, pass: overrides });
  const actions = channelTransition(before, after, {
    copies: new Set(rows.copies),
    retired: new Set(Object.keys(rows.retired) as Channel[]),
    replaceCodes: body.replaceCodes,
  });
  const rotates = actions.some((a) => a.kind === 'rotate_codes');
  if (body.replaceCodes) {
    const touchesDigital = (Object.keys(body.channels) as Channel[]).some((c) =>
      DIGITAL_CHANNELS.includes(c),
    );
    if (touchesDigital && !anyDigitalOn(after)) refuseAllOff();
  }
  // Refused before anything is written: the pass would be off with its old code still working.
  if (rotates) {
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
  if (rotates) {
    // A system actor id, not the user's: a replace keeps the pass's print (the 0115 trigger reads the prefix).
    // The user is on the channel audit rows above.
    const done = await rotateCode(
      ctx,
      pass.id,
      `channel_replace:${ctx.requestId ?? ctx.ids.id()}`,
      authority,
    );
    if (done === 'rotated') {
      await countNewCode(ctx, pass.id);
      await noticeHolder(ctx, pass.id);
    }
  }
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
): Promise<BulkResponse> {
  const value: PassChannelState | null = body.action === 'reset' ? null : body.action;
  const channels = Object.fromEntries(body.channels.map((c) => [c, value]));
  const out: BulkResponse = { done: 0, skipped: [] };
  const bulkKey = ctx.requestId ?? ctx.ids.id();
  for (const pass of passes) {
    try {
      await putPassChannels(ctx, actor, authority, pass, {
        channels,
        notify: body.notify,
        replaceCodes: false,
      });
      // The overrides are in; the new code waits for its windows in one job per pass.
      if (body.replaceCodes && value === 'off')
        await ctx.env.JOBS.send({
          kind: 'channel.replace_code',
          passId: pass.id,
          key: `channel_bulk:${bulkKey}`,
        });
      out.done += 1;
    } catch (error) {
      if (!(error instanceof RateLimitedError)) throw error;
      out.skipped.push({ id: pass.id, code: 'RATE_LIMITED' });
    }
  }
  return out;
}
