import { levelState } from '../../../shared/channels.ts';
import type {
  Channel,
  ChannelLevel,
  ChannelReason,
  ChannelStatus,
} from '../../../shared/contracts/channels.ts';
import { CHANNELS } from '../../../shared/contracts/channels.ts';
import type { levels } from './service.ts';

type Upper = Awaited<ReturnType<typeof levels>>;

/** What the caller may change, per level. PassBook and Plan: a platform admin only. */
export interface ChainCan {
  platform: boolean;
  org: boolean;
  template: boolean;
}

/** PassBook, Plan and Organization for one channel. A platform hold shows as PassBook, not enrolled. */
export function upperLevels(
  c: Channel,
  upper: Upper,
  held: boolean,
  can: ChainCan,
): ChannelLevel[] {
  const reasons: [ChannelLevel['level'], ChannelReason | undefined][] = [
    ['passbook', upper.platform[c] ?? (held ? 'not_enrolled' : undefined)],
    ['plan', upper.entitlement?.[c]],
    ['org', upper.org[c]],
  ];
  const allowed = { passbook: can.platform, plan: can.platform, org: can.org } as const;
  return reasons.map(([level, reason]) => ({
    level,
    state: levelState(level, reason),
    ...(reason ? { reason } : {}),
    canChange: allowed[level as 'passbook' | 'plan' | 'org'],
  }));
}

/** The levels a stop at `status` leaves untouched below it: the level it names is the one that stops it. */
function ownLevel(
  level: 'template' | 'pass',
  status: ChannelStatus,
  canChange: boolean,
): ChannelLevel {
  const reason = !status.on && status.source === level ? status.reason : undefined;
  return {
    level,
    state: levelState(level, reason),
    ...(reason ? { reason } : {}),
    canChange,
  };
}

/** The chain of every channel for a template: the upper levels, then the template's own. */
export function templateChains(
  upper: Upper,
  effective: Record<Channel, ChannelStatus>,
  can: ChainCan,
): Record<Channel, ChannelLevel[]> {
  return Object.fromEntries(
    CHANNELS.map((c) => [
      c,
      [...upperLevels(c, upper, false, can), ownLevel('template', effective[c], can.template)],
    ]),
  ) as Record<Channel, ChannelLevel[]>;
}

/** The chain of every channel for a pass: it ends in This pass. */
export function passChains(
  upper: Upper,
  effective: Record<Channel, ChannelStatus>,
  can: ChainCan,
): Record<Channel, ChannelLevel[]> {
  const own = templateChains(upper, effective, can);
  return Object.fromEntries(
    CHANNELS.map((c) => [c, [...(own[c] ?? []), ownLevel('pass', effective[c], can.template)]]),
  ) as Record<Channel, ChannelLevel[]>;
}
