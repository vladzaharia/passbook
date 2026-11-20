import type { z } from 'zod';
import {
  anyDigitalOn,
  DIGITAL_CHANNELS,
  effectiveChannels,
  templateDefault,
} from '../../../shared/channels.ts';
import type {
  Channel,
  PassChannelState,
  PutTemplateChannelsResponseSchema,
  TemplateChannelState,
} from '../../../shared/contracts/channels.ts';
import type { Mode } from '../../../shared/contracts/common.ts';
import { bump, read } from '../../platform/counters.ts';
import { ConflictError, RateLimitedError } from '../../platform/errors.ts';
import type { ServiceContext } from '../../platform/service-context.ts';
import type { TenantPassWrite } from '../passes/http.ts';
import type { Actor } from '../passes/service.ts';
import { startApplyInstance } from './apply-start.ts';
import { assertNoOpenWindow, refuseAllOff, refuseUnsupported, replaceSet } from './replace.ts';
import { templateReplaceable } from './replaceable.ts';
import * as repo from './repo.ts';
import { rotatedCount } from './repo-replace.ts';
import { latestRun, pendingRun } from './repo-runs.ts';
import { writeTemplatePolicy } from './repo-write.ts';
import { loadTemplate } from './service.ts';
import { openWindows, splitWindows, WINDOW_HORIZON_MS } from './windows.ts';

type PutTemplateResponse = z.infer<typeof PutTemplateChannelsResponseSchema>;

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
/** Policy saves one template may make per UTC day and mode; a revert counts. */
export const TEMPLATE_SAVES_PER_DAY = 6;
/** A save starts its apply run this long after the last save of the template. */
export const APPLY_DEBOUNCE_MS = 10 * 60_000;

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
    expectedCleared?: number | undefined;
  },
): Promise<PutTemplateResponse> {
  const { inputs, policy, revision } = await loadTemplate(ctx, template, mode);
  if (!body.dryRun && body.revision !== revision)
    throw new ConflictError('The channels changed. Reload and retry.', 'TEMPLATE_CHANNELS_CHANGED');
  const merged = { ...policy, ...body.channels };
  const changed = (Object.keys(body.channels) as Channel[]).filter(
    (c) => (policy?.[c] ?? templateDefault(c)) !== body.channels[c],
  );
  const now = ctx.clock.now();
  const replace = body.replaceCodes ? replaceSet(merged, changed) : [];
  const supported = await templateReplaceable(ctx, template, mode);
  const digitalOn = anyDigitalOn(effectiveChannels({ ...inputs, template: merged }));
  // A dry run warns about windows even without the box ticked; a real save needs them only to replace.
  const windows =
    body.dryRun || replace.length > 0
      ? await openWindows(ctx, template.orgId, mode, template.id, now, WINDOW_HORIZON_MS)
      : [];
  const replacing = replace.length > 0 && supported && digitalOn;
  if (!body.dryRun && replace.length > 0 && changed.length > 0) {
    if (!supported) refuseUnsupported();
    if (!digitalOn) refuseAllOff();
    assertNoOpenWindow(windows);
  }
  const day = now - (now % DAY);
  const saves = `channels:template:${template.orgId}:${mode}:${template.id}`;
  if (
    !body.dryRun &&
    changed.length > 0 &&
    (await read(ctx.env.DB, saves, day)) >= TEMPLATE_SAVES_PER_DAY
  )
    throw new RateLimitedError(Math.ceil((day + DAY - now) / 1000));
  const runId = ctx.ids.id();
  // A failed run left its range part applied: the next run starts from where that one began.
  const failed =
    !body.dryRun && changed.length > 0
      ? await latestRun(ctx.env.DB, template.orgId, mode, template.id)
      : null;
  const applyFrom = failed?.state === 'failed' ? failed.from : (policy ?? {});
  const impact = [];
  const cleared: Channel[] = [];
  for (const channel of changed) {
    const prev = policy?.[channel] ?? templateDefault(channel);
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
    const rotated =
      replacing && replace.includes(channel) && next !== 'on'
        ? await rotatedCount(ctx.env.DB, template.orgId, mode, template.id, channel, next)
        : 0;
    impact.push({ channel, passes, rotated, clearedOverrides });
  }
  const clearedTotal = impact.reduce((n, i) => n + i.clearedOverrides, 0);
  if (!body.dryRun && body.expectedCleared !== undefined && body.expectedCleared !== clearedTotal)
    throw new ConflictError(
      `This now clears ${clearedTotal} pass overrides, not ${body.expectedCleared}. Review and save again.`,
      'TEMPLATE_CHANNELS_IMPACT_CHANGED',
    );
  // The pending run's channels stay: one run replaces what every save joined to it asked for.
  const joined =
    !body.dryRun && changed.length > 0
      ? await pendingRun(ctx.env.DB, template.orgId, mode, template.id)
      : null;
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
        cleared: clearedTotal,
      },
      body.revision,
      {
        runId,
        from: applyFrom,
        dueAt: now + APPLY_DEBOUNCE_MS,
        replace: [...new Set([...(joined?.replace ?? []), ...replace])],
      },
    );
  let workflowInstanceId: string | null = null;
  if (!body.dryRun && changed.length > 0) {
    await bump(ctx.env.DB, saves, day);
    const pending = await pendingRun(ctx.env.DB, template.orgId, mode, template.id);
    workflowInstanceId = pending?.id ?? null;
    // Only the save that opened the run starts its instance; later saves just push the start back.
    if (pending?.id === runId) await startApplyInstance(ctx, runId);
  }
  const saved = body.dryRun ? policy : merged;
  const view = await loadTemplate(ctx, template, mode, saved ?? undefined);
  const wrote = !body.dryRun && changed.length > 0;
  return {
    channels: saved,
    revision: wrote ? revision + 1 : revision,
    effective: effectiveChannels(view.inputs),
    impact,
    workflowInstanceId,
    replaceSupported: supported,
    ...splitWindows(windows),
    allOff: !digitalOn && changed.some((c) => DIGITAL_CHANNELS.includes(c)),
  };
}
