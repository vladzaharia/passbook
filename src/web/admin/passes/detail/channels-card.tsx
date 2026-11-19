import { useState } from 'react';
import { nothingOn } from '@/shared/channels.ts';
import {
  CHANNELS,
  type Channel,
  type ChannelStatus,
  type PassChannelsDto,
} from '@/shared/contracts/channels.ts';
import type { PassDetailDto } from '@/shared/contracts/passes.ts';
import {
  CHANNEL_COPY,
  CHANNEL_LABEL,
  CHANNEL_SOURCE_LABEL,
  channelReason,
} from '@/shared/copy/channels.ts';
import { channelOffConfirm } from '../../../lib/confirms.ts';
import { formatDay } from '../../../lib/format.ts';
import {
  Button,
  Callout,
  Card,
  CardBody,
  CardHeader,
  ConfirmDialog,
  ErrorState,
  SkeletonRows,
  Switch,
  toast,
} from '../../../ui/index.ts';
import { usePutPassChannels } from '../channels-api.ts';
import { usePassChannels } from '../print-api.ts';
import { PrintCard } from './print-card.tsx';

/** A pass can flip a channel only when no organization, platform or design limit blocks it. */
const SWITCHABLE = new Set(['template_off', 'pass_off']);
const canSwitch = (s: ChannelStatus) =>
  s.on || (s.reason !== undefined && SWITCHABLE.has(s.reason));

function Row({
  channel,
  status,
  overridden,
  disabled,
  busy,
  onSwitch,
  onReset,
}: {
  channel: Channel;
  status: ChannelStatus;
  overridden: boolean;
  disabled: boolean;
  busy: boolean;
  onSwitch: (on: boolean) => void;
  onReset: () => void;
}) {
  const label = CHANNEL_LABEL[channel];
  const blocked = !status.on && !canSwitch(status);
  const meta =
    blocked && status.reason
      ? channelReason(channel, status.reason)
      : [
          `${status.on ? 'On' : 'Off'} · ${CHANNEL_SOURCE_LABEL[status.source]}`,
          status.retiredAt ? `Retired ${formatDay(status.retiredAt)}` : null,
        ]
          .filter(Boolean)
          .join(' · ');
  return (
    <li className="flex min-h-14 items-center gap-3 py-2">
      <div className="min-w-0 flex-1">
        <p className="text-sm font-medium text-fg-strong">{label}</p>
        <p className="text-xs text-fg-muted">{meta}</p>
      </div>
      {overridden ? (
        <Button variant="ghost" size="sm" disabled={disabled || busy} onClick={onReset}>
          {CHANNEL_COPY.useTemplate}
        </Button>
      ) : null}
      <Switch
        aria-label={label}
        checked={status.on}
        disabled={disabled || busy || blocked}
        onCheckedChange={onSwitch}
      />
    </li>
  );
}

/**
 * Where a pass's copies can be offered: state, deciding level and retired date per channel, a
 * switch for the pass's own override and Use template to drop it. Print, Reprint and Void print sit
 * under the list. Turning a digital channel off asks first; it never replaces codes.
 */
export function ChannelsCard({ pass, readOnly }: { pass: PassDetailDto; readOnly: boolean }) {
  const query = usePassChannels(pass.id);
  const put = usePutPassChannels(pass.id);
  const [ask, setAsk] = useState<Channel | null>(null);
  const voided = pass.status === 'voided' || pass.removedAt != null;
  const disabled = readOnly || voided;

  const save = (channels: Parameters<typeof put.mutate>[0]) =>
    put.mutateAsync(channels).then(
      () => {
        toast.success(CHANNEL_COPY.saved);
      },
      (error) => {
        toast.error(error, 'Could not change channels.');
      },
    );
  const data: PassChannelsDto | undefined = query.data;
  const toggle = (channel: Channel, on: boolean) => {
    if (on) return void save({ [channel]: 'on' as const });
    setAsk(channel);
  };

  return (
    <Card>
      <CardHeader title={CHANNEL_COPY.card} />
      <CardBody>
        {query.isPending ? (
          <SkeletonRows rows={4} label="Loading channels" />
        ) : query.isError || !data ? (
          <ErrorState inline error={query.error} onRetry={() => void query.refetch()} />
        ) : (
          <div className="flex flex-col gap-4">
            {nothingOn(data.effective) ? (
              <Callout tone="warning">{CHANNEL_COPY.nothingOn}</Callout>
            ) : null}
            <ul className="divide-y divide-border">
              {CHANNELS.map((channel) => (
                <Row
                  key={channel}
                  channel={channel}
                  status={data.effective[channel]}
                  overridden={data.overrides[channel] !== undefined}
                  disabled={disabled}
                  busy={put.isPending}
                  onSwitch={(on) => toggle(channel, on)}
                  onReset={() => void save({ [channel]: null })}
                />
              ))}
            </ul>
            <div className="border-t border-border pt-4">
              <PrintCard pass={pass} readOnly={readOnly} bare />
            </div>
          </div>
        )}
      </CardBody>
      {ask ? (
        <ConfirmDialog
          open
          onOpenChange={(open) => !open && setAsk(null)}
          {...channelOffConfirm(CHANNEL_LABEL[ask], ask === 'paper')}
          onConfirm={() => save({ [ask]: 'off' })}
        />
      ) : null}
    </Card>
  );
}
