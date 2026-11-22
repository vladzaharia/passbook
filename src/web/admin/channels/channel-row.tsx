import type { ReactNode } from 'react';
import type { Channel, ChannelStatus } from '@/shared/contracts/channels.ts';
import {
  CHANNEL_COPY,
  CHANNEL_FIX_LABEL,
  CHANNEL_LABEL,
  channelWhy,
} from '@/shared/copy/channels.ts';
import { StatusPill, Tooltip } from '../../ui/index.ts';

export interface ChannelRowProps {
  channel: Channel;
  /** The effective state at this level. */
  status: ChannelStatus;
  /** True when this level cannot change the row: it shows a label instead of the control. */
  locked?: boolean;
  /** The control: segmented or switch. */
  control?: ReactNode;
  /** Beside the control, e.g. "Template default". */
  extra?: ReactNode;
  /** Shown instead of the generic label, e.g. "Apple phone tap". */
  label?: string;
  /** Replaces the generic reason, e.g. "Waiting for Apple approval". */
  reasonText?: string;
  /** The chain of levels (ChainBadge) between the name and the control. */
  chain?: ReactNode;
}

/** A left tooltip stays inside a narrow screen: the label sits at the right edge. */
const TIP_WIDTH = 'max-w-[min(20rem,calc(100vw-9rem))]';

/** What the locked label says: unavailable outright, or turned off by a higher level. */
const UNAVAILABLE = new Set(['not_released', 'not_enrolled', 'no_design', 'not_included']);

/**
 * One channel at any level: name, effective state and the level's own control. A row this level
 * cannot change shows a muted "Not available" or "Disabled" instead; the reason and where to fix
 * it sit in its tooltip. Every row is the same height. Every channel list renders these.
 */
export function ChannelRow({
  channel,
  status,
  locked,
  control,
  extra,
  label,
  reasonText,
  chain,
}: ChannelRowProps) {
  const why =
    !status.on && status.reason ? channelWhy(channel, status.reason, status.source) : null;
  const state = status.on ? 'on' : 'off';
  const word =
    status.reason && UNAVAILABLE.has(status.reason)
      ? CHANNEL_COPY.notAvailable
      : CHANNEL_COPY.disabled;
  const detail = [
    reasonText ?? why?.text,
    why?.copiesStay && !reasonText ? CHANNEL_COPY.copiesStay : null,
    why?.fix && !reasonText ? `Change it in ${CHANNEL_FIX_LABEL[why.fix]}.` : null,
  ]
    .filter(Boolean)
    .join('. ')
    .replace(/\.\./g, '.');
  return (
    <li
      className={
        chain
          ? // Name and control on one line, the chain under them; wide enough, all three in a row.
            'grid min-h-14 grid-cols-[1fr_auto] items-center gap-x-4 gap-y-2 py-2 @2xl:grid-cols-[auto_1fr_auto]'
          : 'flex min-h-14 items-center justify-between gap-4 py-2'
      }
    >
      <p className="flex min-w-0 items-center gap-2 text-sm font-medium text-fg-strong">
        {label ?? CHANNEL_LABEL[channel]}
        <StatusPill status={state} tone={status.on ? 'success' : 'neutral'}>
          {status.on ? 'On' : 'Off'}
        </StatusPill>
      </p>
      {chain ? (
        <div className="col-span-2 row-start-2 min-w-0 @2xl:col-span-1 @2xl:col-start-2 @2xl:row-start-1">
          {chain}
        </div>
      ) : null}
      <div
        className={`flex shrink-0 items-center gap-3 ${chain ? 'col-start-2 row-start-1 @2xl:col-start-3' : ''}`}
      >
        {locked ? (
          <Tooltip content={detail} side="left" className={TIP_WIDTH}>
            <button
              type="button"
              aria-label={`${word}. ${detail}`}
              className="cursor-default text-sm text-fg-muted pointer-coarse:min-h-11 pointer-coarse:min-w-11"
            >
              {word}
            </button>
          </Tooltip>
        ) : (
          <>
            {extra}
            {control}
          </>
        )}
      </div>
    </li>
  );
}

/** The list every channel control sits in. */
export function ChannelList({ children }: { children: ReactNode }) {
  return <ul className="@container divide-y divide-border">{children}</ul>;
}
