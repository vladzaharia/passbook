import {
  CHANNELS,
  type Channel,
  type ChannelReason,
  type ChannelSource,
  type EffectiveChannels,
  type PassChannelState,
  type TemplateChannelState,
} from './contracts/channels.ts';

/** The four wallet and page copies that share one code family. */
export const DIGITAL_CHANNELS: readonly Channel[] = ['mobile', 'apple', 'google', 'samsung'];
export const isDigital = (c: Channel): boolean => DIGITAL_CHANNELS.includes(c);

type Per<T> = Partial<Record<Channel, T>>;

/** Everything the pure resolver needs; the loader (modules/channels/service.ts) fills it. */
export interface ChannelInputs {
  /** Channels the platform blocks, with the reason (not_released, printing_off). */
  platform: Per<ChannelReason>;
  /** Channels the org blocks or has not enabled (not_enrolled, tags_off, blocked). */
  org: Per<ChannelReason>;
  /** Channels the pass's pinned version cannot serve (no_design). */
  capability: Per<ChannelReason>;
  /** The stored template policy; null or absent channels use the defaults. */
  template: Per<TemplateChannelState> | null;
  /** Pass overrides; absent follows the template. */
  pass: Per<PassChannelState>;
  /** When a plain Turn off retired the pass's copies. */
  retired: Per<number>;
  /** The level that turned the channel off when it was retired. */
  retiredCause?: Per<'pass' | 'template'>;
}

export function templateDefault(channel: Channel): TemplateChannelState {
  return channel === 'paper' ? 'off' : 'on';
}

/**
 * effective(c) = platform ∧ org ∧ template ≠ never ∧ (pass ?? template == on).
 * The first failing level is the reason. A pass may turn on what its template has off.
 */
export function effectiveChannels(i: ChannelInputs): EffectiveChannels {
  const out = {} as EffectiveChannels;
  for (const c of CHANNELS) {
    out[c] = withRetired(statusOf(i, c), i.retired[c], i.retiredCause?.[c]);
  }
  return out;
}

/** retiredAt marks an off channel only: an on channel is never retired. */
function withRetired(
  s: EffectiveChannels[Channel],
  at: number | undefined,
  cause: 'pass' | 'template' | undefined,
) {
  return at === undefined || s.on
    ? s
    : { ...s, retiredAt: at, ...(cause ? { retiredCause: cause } : {}) };
}

function off(source: ChannelSource, reason: ChannelReason): EffectiveChannels[Channel] {
  return { on: false, source, reason };
}

function statusOf(i: ChannelInputs, c: Channel): EffectiveChannels[Channel] {
  const platform = i.platform[c];
  if (platform) return off('platform', platform);
  const org = i.org[c];
  if (org) return off('org', org);
  const capability = i.capability[c];
  if (capability) return off('template', capability);
  const state = i.template?.[c] ?? templateDefault(c);
  if (state === 'never') return off('template', 'never');
  const override = i.pass[c];
  if (override === 'on') return { on: true, source: 'pass' };
  if (override === 'off') return off('pass', 'pass_off');
  return state === 'on' ? { on: true, source: 'template' } : off('template', 'template_off');
}

export const anyDigitalOn = (e: EffectiveChannels): boolean =>
  DIGITAL_CHANNELS.some((c) => e[c].on);
export const nothingOn = (e: EffectiveChannels): boolean => CHANNELS.every((c) => !e[c].on);

/** One thing a change of effective channels asks the system to do. */
export type ChannelAction =
  /** Stop offering and updating the channel; retired_at is set (Apple variant, provider retirement later). */
  | { kind: 'retire'; channel: Channel }
  /** The channel works again; `warn` when copies existed ("Retired copies work again"). */
  | { kind: 'restore'; channel: Channel; warn: boolean }
  /** Paper off ends the pass's active prints. */
  | { kind: 'void_prints' }
  /** "Turn off and replace codes": new scan code, for a pass with a copy in a retired channel. */
  | { kind: 'rotate_codes'; channels: Channel[] };

export interface TransitionOptions {
  /** The explicit "Turn off and replace codes" action; a set limits it to those channels. */
  replaceCodes?: boolean | ReadonlySet<Channel>;
  /** Channels where the pass has copy evidence. */
  copies?: ReadonlySet<Channel>;
  /** Channels with retired_at set now. */
  retired?: ReadonlySet<Channel>;
}

/**
 * The one transition for every level (pass override, template policy, org block, release, capability).
 * A plain off never rotates; a kill switch (org or platform source) never retires or rotates. Prints
 * are voided only by paper going off, never by rotation.
 */
export function channelTransition(
  before: EffectiveChannels,
  after: EffectiveChannels,
  opts: TransitionOptions = {},
): ChannelAction[] {
  const actions: ChannelAction[] = [];
  const copies = opts.copies ?? new Set<Channel>();
  const retired = opts.retired ?? new Set<Channel>();
  const turnedOff: Channel[] = [];
  const kill = (e: EffectiveChannels[Channel]) => e.source === 'org' || e.source === 'platform';
  for (const c of CHANNELS) {
    const now = after[c].on;
    if (now) {
      if (retired.has(c)) actions.push({ kind: 'restore', channel: c, warn: copies.has(c) });
      continue;
    }
    // Retire when a pass or template level turns it off: from on, or (with copy evidence) when a kill
    // switch lifts onto a lower-level off. A kill switch itself never retires.
    const wasLive = before[c].on || (kill(before[c]) && copies.has(c));
    const lowered = !kill(after[c]) && wasLive && !retired.has(c);
    if (!lowered) continue;
    if (c === 'paper') actions.push({ kind: 'void_prints' });
    else actions.push({ kind: 'retire', channel: c });
    if (isDigital(c) && copies.has(c)) turnedOff.push(c);
  }
  // A digital channel that is off after the change, with copies, and was turned off now or earlier
  // (retired): its copies still scan the old code. That covers "re-enable after all off" too.
  const replace = opts.replaceCodes;
  const rotate = replace
    ? DIGITAL_CHANNELS.filter(
        (c) =>
          !after[c].on &&
          copies.has(c) &&
          (turnedOff.includes(c) || retired.has(c)) &&
          (replace === true || replace.has(c)),
      )
    : [];
  if (rotate.length > 0 && anyDigitalOn(after))
    actions.push({ kind: 'rotate_codes', channels: rotate });
  return actions;
}
