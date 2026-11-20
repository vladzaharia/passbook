import type { z } from 'zod';
import {
  anyDigitalOn,
  channelTransition,
  DIGITAL_CHANNELS,
  effectiveChannels,
} from '../../../shared/channels.ts';
import {
  type BulkChannelsPreviewSchema,
  CHANNELS,
  type Channel,
  type ChannelWindow,
  type PassChannelState,
} from '../../../shared/contracts/channels.ts';
import type { ServiceContext } from '../../platform/service-context.ts';
import type { Pass } from '../passes/repo-map.ts';
import { passReplaceable } from './replaceable.ts';
import { rotationOwed } from './repo-replace.ts';
import { loadPass } from './service.ts';
import { openWindows, splitWindows } from './windows.ts';

/**
 * What changing a pass's overrides does: effective before and after, the transition actions, and
 * whether a new code is owed. The save and the bulk dry run both read it, so they cannot disagree.
 */
export async function planPass(
  ctx: ServiceContext,
  pass: Pass,
  body: { channels: Partial<Record<Channel, PassChannelState | null>>; replaceCodes: boolean },
) {
  const now = ctx.clock.now();
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
  const rotation = actions.find((a) => a.kind === 'rotate_codes');
  const rotates = rotation !== undefined;
  // A channel retired before the pass's last new code was already covered by it: no second code.
  const retiredNow = Object.fromEntries(
    actions.flatMap((a) => (a.kind === 'retire' ? [[a.channel, now]] : [])),
  );
  const owed =
    rotation?.kind === 'rotate_codes' &&
    (await rotationOwed(
      ctx.env.DB,
      pass.orgId,
      pass.id,
      { ...rows.retired, ...retiredNow },
      rotation.channels,
    ));
  return { inputs, rows, before, after, overrides, actions, rotation, rotates, owed };
}

/**
 * The bulk Channels dialog's preview: per channel how many passes turn off and how many get a new
 * code, from the same plan, eligibility and windows a real save uses. Nothing is written.
 */
export async function previewBulk(
  ctx: ServiceContext,
  passes: readonly Pass[],
  body: { action: string; replaceCodes: boolean },
  channels: Partial<Record<Channel, PassChannelState | null>>,
): Promise<{ done: 0; skipped: []; preview: z.infer<typeof BulkChannelsPreviewSchema> }> {
  const replaceCodes = body.replaceCodes && body.action === 'off';
  const off = new Map<Channel, number>();
  const rotated = new Map<Channel, number>();
  let unsupported = 0;
  let allOff = 0;
  const replaceable = new Map<string, Promise<boolean>>();
  const templates = new Map<string, Pass>();
  for (const pass of passes) {
    const plan = await planPass(ctx, pass, { channels, replaceCodes });
    for (const c of CHANNELS)
      if (plan.before[c].on && !plan.after[c].on) off.set(c, (off.get(c) ?? 0) + 1);
    if (!replaceCodes) continue;
    templates.set(`${pass.orgId}:${pass.mode}:${pass.templateId}`, pass);
    if (
      !anyDigitalOn(plan.after) &&
      Object.keys(channels).some((c) => DIGITAL_CHANNELS.includes(c as Channel))
    ) {
      allOff += 1;
      continue;
    }
    if (!plan.owed || plan.rotation?.kind !== 'rotate_codes') continue;
    // One manifest read per pinned version, however many passes share it.
    const key = `${pass.templateId}:${pass.templateVersion}`;
    if (!replaceable.has(key)) replaceable.set(key, passReplaceable(ctx, pass));
    if (!(await replaceable.get(key))) {
      unsupported += 1;
      continue;
    }
    for (const c of plan.rotation.channels) rotated.set(c, (rotated.get(c) ?? 0) + 1);
  }
  // One window query per template, not per pass.
  const seen = new Map<string, ChannelWindow>();
  const now = ctx.clock.now();
  for (const pass of templates.values())
    for (const w of await openWindows(ctx, pass.orgId, pass.mode, pass.templateId, now))
      seen.set(w.id, w);
  return {
    done: 0,
    skipped: [],
    preview: {
      impact: CHANNELS.flatMap((channel) =>
        off.has(channel) || rotated.has(channel)
          ? [{ channel, passes: off.get(channel) ?? 0, rotated: rotated.get(channel) ?? 0 }]
          : [],
      ),
      unsupported,
      allOff,
      ...splitWindows([...seen.values()]),
    },
  };
}
