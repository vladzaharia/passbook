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
}

/** What the locked label says: unavailable outright, or turned off by a higher level. */
const UNAVAILABLE = new Set(['not_released', 'not_enrolled', 'no_design']);

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
}: ChannelRowProps) {
  const why = !status.on && status.reason ? channelWhy(channel, status.reason) : null;
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
    <li className="flex min-h-14 items-center justify-between gap-4 py-2">
      <p className="flex min-w-0 items-center gap-2 text-sm font-medium text-fg-strong">
        {label ?? CHANNEL_LABEL[channel]}
        <StatusPill status={state} tone={status.on ? 'success' : 'neutral'}>
          {status.on ? 'On' : 'Off'}
        </StatusPill>
      </p>
      <div className="flex shrink-0 items-center gap-3">
        {locked ? (
          <Tooltip content={detail} side="left">
            <button
              type="button"
              aria-label={`${word}. ${detail}`}
              className="cursor-default text-sm text-fg-muted"
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
  return <ul className="divide-y divide-border">{children}</ul>;
}
