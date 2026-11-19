import type { z } from 'zod';
import { channelTransition, effectiveChannels, templateDefault } from '../../../shared/channels.ts';
import {
  type BulkPassChannelsResponseSchema,
  type BulkPassChannelsSchema,
  CHANNELS,
  type Channel,
  type PassChannelState,
  type PutPassChannelsSchema,
  type PutTemplateChannelsResponseSchema,
  type TemplateChannelState,
} from '../../../shared/contracts/channels.ts';
import type { Mode } from '../../../shared/contracts/common.ts';
import { bump, read } from '../../platform/counters.ts';
import { AppError, ConflictError, RateLimitedError } from '../../platform/errors.ts';
import type { ServiceContext } from '../../platform/service-context.ts';
import { recordPassEvents } from '../events/record.ts';
import type { TenantPassWrite } from '../passes/http.ts';
import { publishPass } from '../passes/publish.ts';
import type { Pass } from '../passes/repo-map.ts';
import type { Actor } from '../passes/service.ts';
import * as repo from './repo.ts';
import { writePassChannels, writeTemplatePolicy } from './repo-write.ts';
import { loadPass, loadTemplate, passChannels } from './service.ts';

type PutPass = z.infer<typeof PutPassChannelsSchema>;
type PutTemplateResponse = z.infer<typeof PutTemplateChannelsResponseSchema>;
type Bulk = z.infer<typeof BulkPassChannelsSchema>;
type BulkResponse = z.infer<typeof BulkPassChannelsResponseSchema>;

const HOUR = 3_600_000;
/** Override changes one pass may make per hour (the same window as New code). */
export const OVERRIDE_CHANGES_PER_HOUR = 20;

const replaceUnavailable = () =>
  new ConflictError('Replacing codes is not available yet.', 'CHANNEL_REPLACE_UNAVAILABLE');

/** Sets or clears a pass's overrides; effective changes are audited and journaled. */
export async function putPassChannels(
  ctx: ServiceContext,
  actor: Actor,
  authority: TenantPassWrite,
  pass: Pass,
  body: PutPass,
) {
  if (body.replaceCodes) throw replaceUnavailable();
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
  });

  const touched = new Set<Channel>(Object.keys(body.channels) as Channel[]);
  const retired = { ...rows.retired };
  for (const a of actions) {
    if (a.kind === 'retire') {
      touched.add(a.channel);
      retired[a.channel] = now;
    } else if (a.kind === 'restore') {
      touched.add(a.channel);
      delete retired[a.channel];
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
    })),
    audits,
  );
  await bump(ctx.env.DB, key, window);
  if (before.apple.on !== after.apple.on) await bumpForApple(ctx, actor, authority, pass);
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
  return passChannels(ctx, pass);
}

/**
 * Apple flipped for this pass: republish (force) so the version moves, `passesUpdatedSince` and
 * Last-Modified follow and the push goes out (N4). The device then fetches the voided variant, or
 * the live pass again (modules/apple/variant.ts). A failure is logged: a repeat PUT changes nothing.
 */
async function bumpForApple(
  ctx: ServiceContext,
  actor: Actor,
  authority: TenantPassWrite,
  pass: Pass,
): Promise<void> {
  if (pass.removedAt !== null || pass.status !== 'active') return;
  try {
    await publishPass(ctx, {
      passId: pass.id,
      cause: actor.type === 'api_key' ? 'api' : 'admin',
      actor,
      authority,
      force: true,
      notify: false,
    });
  } catch (error) {
    if (!(error instanceof AppError)) throw error;
    ctx.log.error('channels.apple_bump_failed', {
      code: 'CHANNEL_APPLE_BUMP',
      orgId: pass.orgId,
      passId: pass.id,
      cause: error.code,
    });
  }
}

/** Many passes, one org and mode: on or off sets the override, reset clears it. */
export async function bulkPassChannels(
  ctx: ServiceContext,
  actor: Actor,
  authority: TenantPassWrite,
  passes: Pass[],
  body: Bulk,
): Promise<BulkResponse> {
  if (body.replaceCodes) throw replaceUnavailable();
  const value: PassChannelState | null = body.action === 'reset' ? null : body.action;
  const channels = Object.fromEntries(body.channels.map((c) => [c, value]));
  const out: BulkResponse = { done: 0, skipped: [] };
  for (const pass of passes) {
    try {
      await putPassChannels(ctx, actor, authority, pass, {
        channels,
        notify: body.notify,
        replaceCodes: false,
      });
      out.done += 1;
    } catch (error) {
      if (!(error instanceof RateLimitedError)) throw error;
      out.skipped.push({ id: pass.id, code: 'RATE_LIMITED' });
    }
  }
  return out;
}

const onWith = (state: TemplateChannelState, ov: PassChannelState | null) =>
  state !== 'never' && (ov === null ? state === 'on' : ov === 'on');

/** Saves a template's policy for one mode. `dryRun` returns the impact only. */
export async function putTemplateChannels(
  ctx: ServiceContext,
  actor: Actor,
  authority: TenantPassWrite,
  template: repo.TemplateRef,
  mode: Mode,
  body: {
    channels: Partial<Record<Channel, TemplateChannelState>>;
    revision: number;
    dryRun: boolean;
    replaceCodes: boolean;
  },
): Promise<PutTemplateResponse> {
  if (body.replaceCodes) throw replaceUnavailable();
  const { inputs, policy, revision } = await loadTemplate(ctx, template, mode);
  if (!body.dryRun && body.revision !== revision)
    throw new ConflictError('The channels changed. Reload and retry.', 'TEMPLATE_CHANNELS_CHANGED');
  const merged = { ...policy, ...body.channels };
  const changed = (Object.keys(body.channels) as Channel[]).filter(
    (c) => (policy?.[c] ?? templateDefault(c, inputs.scanTags)) !== body.channels[c],
  );
  const impact = [];
  const cleared: Channel[] = [];
  for (const channel of changed) {
    const prev = policy?.[channel] ?? templateDefault(channel, inputs.scanTags);
    const next = body.channels[channel] as TemplateChannelState;
    const blocked = !effectiveChannels({ ...inputs, template: { ...policy, [channel]: 'on' } })[
      channel
    ].on;
    let passes = 0;
    let clearedOverrides = 0;
    for (const g of await repo.overrideGroups(
      ctx.env.DB,
      template.orgId,
      mode,
      template.id,
      channel,
    )) {
      if (!blocked && onWith(prev, g.override) && !onWith(next, g.override)) passes += g.passes;
      if (next === 'never' && g.override !== null) clearedOverrides += g.passes;
    }
    if (next === 'never') cleared.push(channel);
    impact.push({ channel, passes, rotated: 0, clearedOverrides });
  }
  if (!body.dryRun && changed.length > 0)
    await writeTemplatePolicy(
      ctx,
      authority,
      actor,
      template.id,
      actor.id ?? actor.type,
      merged,
      cleared,
      {
        mode,
        channels: Object.fromEntries(changed.map((c) => [c, body.channels[c]])),
        cleared: impact.reduce((n, i) => n + i.clearedOverrides, 0),
      },
      body.revision,
    );
  const saved = body.dryRun ? policy : merged;
  const view = await loadTemplate(ctx, template, mode, saved ?? undefined);
  const wrote = !body.dryRun && changed.length > 0;
  return {
    channels: saved,
    revision: wrote ? revision + 1 : revision,
    effective: effectiveChannels(view.inputs),
    impact,
    workflowInstanceId: null,
  };
}
