import { Link } from '@tanstack/react-router';
import type { ReactNode } from 'react';
import type { Channel, ChannelStatus } from '@/shared/contracts/channels.ts';
import {
  CHANNEL_COPY,
  CHANNEL_FIX_LABEL,
  CHANNEL_LABEL,
  CHANNEL_SOURCE_LABEL,
  type ChannelFix,
  channelWhy,
} from '@/shared/copy/channels.ts';
import { cn } from '../../lib/cn.ts';
import { formatDay } from '../../lib/format.ts';
import { orgPath, platformPath } from '../../lib/scope.ts';
import { StatusPill } from '../../ui/index.ts';

export interface ChannelRowProps {
  channel: Channel;
  /** The effective state at this level. */
  status: ChannelStatus;
  /** The level this row edits: a fix for its own level is not linked. */
  level: ChannelFix | 'pass';
  /** The control: segmented, switch or nothing when read-only. */
  control?: ReactNode;
  /** Under the state line, e.g. "Template default". */
  extra?: ReactNode;
  orgId?: string | undefined;
  templateId?: string | undefined;
  /** Shown instead of the generic label, e.g. "Apple phone tap". */
  label?: string;
  /** Replaces the generic reason, e.g. "Waiting for Apple approval". */
  reasonText?: string;
  /** A wide control drops under the label on phones; a switch stays beside it. */
  stack?: boolean;
}

function FixLink({
  fix,
  orgId,
  templateId,
}: {
  fix: ChannelFix;
  orgId: string | undefined;
  templateId: string | undefined;
}) {
  const label = CHANNEL_FIX_LABEL[fix];
  if (fix === 'platform') return <Link to={platformPath('/settings')}>{label}</Link>;
  if (!orgId) return null;
  if (fix === 'org') return <Link to={orgPath(orgId, '/settings')}>{label}</Link>;
  if (fix === 'wallet') return <Link to={orgPath(orgId, '/wallet-accounts')}>{label}</Link>;
  if (!templateId) return null;
  return (
    <Link
      to={orgPath(orgId, `/templates/${encodeURIComponent(templateId)}`)}
      search={{ tab: 'channels' }}
    >
      {label}
    </Link>
  );
}

/**
 * One channel at any level: name, effective state, the plain reason when it cannot be on with a
 * link to where it is fixed, and the level's own control. Every channel list in the admin renders
 * these.
 */
export function ChannelRow({
  channel,
  status,
  level,
  control,
  extra,
  orgId,
  templateId,
  label,
  reasonText,
  stack,
}: ChannelRowProps) {
  const why = !status.on && status.reason ? channelWhy(channel, status.reason) : null;
  const state = status.on ? 'on' : 'off';
  const meta = status.on ? CHANNEL_SOURCE_LABEL[status.source] : null;
  return (
    <li
      className={cn(
        'flex min-h-14 gap-2 py-3',
        stack
          ? 'flex-col items-start sm:flex-row sm:items-center sm:justify-between sm:gap-4'
          : 'items-center justify-between gap-4',
      )}
    >
      <div className="min-w-0">
        <p className="flex items-center gap-2 text-sm font-medium text-fg-strong">
          {label ?? CHANNEL_LABEL[channel]}
          <StatusPill status={state} tone={status.on ? 'success' : 'neutral'}>
            {status.on ? 'On' : 'Off'}
          </StatusPill>
        </p>
        <p className="mt-0.5 flex flex-wrap items-center gap-x-2 text-xs text-fg-muted">
          {reasonText && !status.on ? reasonText : why ? why.text : meta}
          {why?.copiesStay ? <span>{CHANNEL_COPY.copiesStay}</span> : null}
          {!reasonText && why?.fix && why.fix !== level ? (
            <span className="[&_a]:text-accent-fg [&_a]:underline">
              <FixLink fix={why.fix} orgId={orgId} templateId={templateId} />
            </span>
          ) : null}
          {status.retiredAt ? <span>Retired {formatDay(status.retiredAt)}</span> : null}
          {extra}
        </p>
      </div>
      {control}
    </li>
  );
}

/** The list every channel control sits in. */
export function ChannelList({ children }: { children: ReactNode }) {
  return <ul className="divide-y divide-border">{children}</ul>;
}
