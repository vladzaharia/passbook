import {
  CHANNELS,
  type ChainLevel,
  type Channel,
  type ChannelLevel,
  type ChannelLevelState,
  type ChannelReason,
  type ChannelSource,
  type EffectiveChannels,
  type PassChannelState,
  type TemplateChannelState,
} from './contracts/channels.ts';
import {
  type EntitlementKey,
  type EntitlementValue,
  entitledValue,
} from './contracts/entitlements.ts';

/** The four wallet and page copies that share one code family. */
export const DIGITAL_CHANNELS: readonly Channel[] = ['mobile', 'apple', 'google', 'samsung'];
export const isDigital = (c: Channel): boolean => DIGITAL_CHANNELS.includes(c);

type Per<T> = Partial<Record<Channel, T>>;

/** Everything the pure resolver needs; the loader (modules/channels/service.ts) fills it. */
export interface ChannelInputs {
  /** Channels the platform blocks, with the reason (not_released, printing_off). */
  platform: Per<ChannelReason>;
  /** Channels the org's plan does not include (not_included). A kill switch like `platform`. */
  entitlement?: Per<ChannelReason>;
  /** Channels the org blocks or has not enabled (not_enrolled, tags_off, blocked). */
  org: Per<ChannelReason>;
  /** Channels the pass's pinned version cannot serve (no_design). */
  capability: Per<ChannelReason>;
  /** The stored template policy; null or absent channels use the defaults. */
  template: Per<TemplateChannelState> | null;
  /** The pinned version's manifest defaults; they stand where the policy is silent. */
  defaults?: Per<'on' | 'off'>;
  /** Pass overrides; absent follows the template. */
  pass: Per<PassChannelState>;
  /** When a plain Turn off retired the pass's copies. */
  retired: Per<number>;
  /** The level that turned the channel off when it was retired. */
  retiredCause?: Per<'pass' | 'template'>;
}

/** A channel's default for a template: its manifest's, else the global one. */
export function defaultOf(i: Pick<ChannelInputs, 'defaults'>, channel: Channel): 'on' | 'off' {
  return i.defaults?.[channel] ?? (templateDefault(channel) as 'on' | 'off');
}

export function templateDefault(channel: Channel): TemplateChannelState {
  return channel === 'paper' ? 'off' : 'on';
}

/**
 * effective(c) = platform ∧ entitlement ∧ org ∧ template ≠ never ∧ (pass ?? template == on).
 * The first failing level is the reason. A pass may turn on what its template has off. An entitlement
 * refusal reports `platform` as its source: like a platform switch it is a kill switch (no retire).
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
  const entitlement = i.entitlement?.[c];
  if (entitlement) return off('platform', entitlement);
  const org = i.org[c];
  if (org) return off('org', org);
  const capability = i.capability[c];
  if (capability) return off('template', capability);
  const state = i.template?.[c] ?? i.defaults?.[c] ?? templateDefault(c);
  if (state === 'never') return off('template', 'never');
  const override = i.pass[c];
  if (override === 'on') return { on: true, source: 'pass' };
  if (override === 'off') return off('pass', 'pass_off');
  return state === 'on' ? { on: true, source: 'template' } : off('template', 'template_off');
}

/** The chain level of an effective status: an entitlement refusal is `plan`, other platform stops `passbook`. */
export function chainLevelOf(source: ChannelSource, reason?: ChannelReason): ChainLevel {
  if (source === 'platform') return reason === 'not_included' ? 'plan' : 'passbook';
  return source;
}

/** How a level reads when `reason` stops it there; no reason is `ok`. One rule for every chain. */
export function levelState(level: ChainLevel, reason?: ChannelReason): ChannelLevelState {
  if (!reason) return 'ok';
  if (level === 'passbook' || level === 'plan') return 'locked';
  return reason === 'not_enrolled' ? 'needs' : 'off';
}

/** The level that stops the channel: the first one not `ok` or `partial`; null when it goes through. */
export const stoppingLevel = (levels: readonly ChannelLevel[]): ChannelLevel | null =>
  levels.find((l) => l.state !== 'ok' && l.state !== 'partial') ?? null;

/** PassBook or the plan stops it: an organization never sees the channel. The one rule every org view uses. */
export const stoppedAboveOrg = (levels: readonly ChannelLevel[]): boolean => {
  const level = stoppingLevel(levels)?.level;
  return level === 'passbook' || level === 'plan';
};

/** The chain an organization reads: its own levels, without PassBook and Plan. */
export const orgChain = (levels: readonly ChannelLevel[]): ChannelLevel[] =>
  levels.filter((l) => l.level !== 'passbook' && l.level !== 'plan');

/** The feature of the organization's plan each delivery channel needs; the rest are not plan-gated. */
const CHANNEL_FEATURE: Partial<Record<Channel, { key: EntitlementKey; want?: string }>> = {
  google: { key: 'wallet.google' },
  samsung: { key: 'wallet.samsung' },
  paper: { key: 'print' },
  nfc: { key: 'nfc', want: 'basic' },
};

export type EntitlementValues = Partial<Record<EntitlementKey, EntitlementValue>>;

/** The channels the plan does not include. Fail closed: a missing value blocks. */
export function blockedByEntitlement(values: EntitlementValues): Per<ChannelReason> {
  const out: Per<ChannelReason> = {};
  for (const [channel, feature] of Object.entries(CHANNEL_FEATURE) as [
    Channel,
    NonNullable<(typeof CHANNEL_FEATURE)[Channel]>,
  ][])
    if (!entitledValue(feature.key, values[feature.key], feature.want))
      out[channel] = 'not_included';
  return out;
}

/** One thing a change of an org's entitlements asks the system to do. */
export type EntitlementEffect =
  /** Channels whose plan state changed: a channel-apply run per template converges the passes. No rotation. */
  {
    kind: 'channel_apply';
    channels: Channel[];
    blockedBefore: Channel[];
    blockedAfter: Channel[];
  };

/**
 * The one transition for entitlements (pattern of `channelTransition`). A downgrade pauses and never
 * deletes: the effect only converges what passes show. An upgrade restores the same way.
 */
export function entitlementTransition(
  before: EntitlementValues,
  after: EntitlementValues,
): EntitlementEffect[] {
  const was = blockedByEntitlement(before);
  const now = blockedByEntitlement(after);
  const channels = CHANNELS.filter((c) => (was[c] !== undefined) !== (now[c] !== undefined));
  return channels.length === 0
    ? []
    : [
        {
          kind: 'channel_apply',
          channels,
          blockedBefore: CHANNELS.filter((c) => was[c] !== undefined),
          blockedAfter: CHANNELS.filter((c) => now[c] !== undefined),
        },
      ];
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
