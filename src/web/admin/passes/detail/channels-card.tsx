import { useState } from 'react';
import { isDigital, nothingOn, orgChain, stoppedAboveOrg } from '@/shared/channels.ts';
import {
  CHANNELS,
  type Channel,
  type ChannelStatus,
  type PassChannelsDto,
} from '@/shared/contracts/channels.ts';
import type { PassDetailDto } from '@/shared/contracts/passes.ts';
import { CHANNEL_COPY, CHANNEL_LABEL } from '@/shared/copy/channels.ts';
import { channelOffConfirm } from '../../../lib/confirms.ts';
import {
  Button,
  Callout,
  Card,
  CardBody,
  CardHeader,
  ErrorState,
  SkeletonRows,
  Switch,
  toast,
} from '../../../ui/index.ts';
import { ChainBadge } from '../../brand/chain-badge.tsx';
import { ChannelList, ChannelRow } from '../../channels/channel-row.tsx';
import { ReplaceOption } from '../../templates/channels/replace-option.tsx';
import { ReviewDialog } from '../../templates/channels/review-dialog.tsx';
import { usePutPassChannels } from '../channels-api.ts';
import { usePassChannels } from '../print-api.ts';
import { PrintCard } from './print-card.tsx';

/** A pass can flip a channel only when no organization, platform or design limit blocks it. */
const SWITCHABLE = new Set(['template_off', 'pass_off']);
const canSwitch = (s: ChannelStatus) =>
  s.on || (s.reason !== undefined && SWITCHABLE.has(s.reason));

/**
 * Where a pass's copies can be offered: state, deciding level and retired date per channel, a
 * switch for the pass's own override and Use template to drop it. Print, Reprint and Void print sit
 * under the list. Turning a digital channel off asks first; it never replaces codes.
 */
export function ChannelsCard({ pass, readOnly }: { pass: PassDetailDto; readOnly: boolean }) {
  const query = usePassChannels(pass.id);
  const put = usePutPassChannels(pass.id);
  const [ask, setAsk] = useState<Channel | null>(null);
  const [replace, setReplace] = useState(false);
  const voided = pass.status === 'voided' || pass.removedAt != null;
  const disabled = readOnly || voided;

  const save = (channels: Parameters<typeof put.mutate>[0]['channels'], replaceCodes = false) =>
    put.mutateAsync({ channels, replaceCodes }).then(
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
    setReplace(false);
    setAsk(channel);
  };
  const allOff = (off: Channel) => replaceInfo?.lastDigital.includes(off) ?? false;
  const replaceInfo = data?.replace;

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
            <ChannelList>
              {CHANNELS.filter((c) => !stoppedAboveOrg(data.levels[c])).map((channel) => {
                const status = data.effective[channel];
                const overridden = data.overrides[channel] !== undefined;
                const busy = disabled || put.isPending;
                return (
                  <ChannelRow
                    key={channel}
                    channel={channel}
                    status={status}
                    chain={<ChainBadge levels={orgChain(data.levels[channel])} />}
                    locked={!canSwitch(status)}
                    extra={
                      overridden ? (
                        <Button
                          variant="link"
                          size="sm"
                          className="text-xs"
                          disabled={busy}
                          onClick={() => void save({ [channel]: null })}
                        >
                          {CHANNEL_COPY.useTemplate}
                        </Button>
                      ) : null
                    }
                    control={
                      <Switch
                        aria-label={CHANNEL_LABEL[channel]}
                        checked={status.on}
                        disabled={busy || !canSwitch(status)}
                        onCheckedChange={(on) => toggle(channel, on)}
                      />
                    }
                  />
                );
              })}
            </ChannelList>
            <PrintCard pass={pass} readOnly={readOnly} bare />
          </div>
        )}
      </CardBody>
      {ask ? (
        <ReviewDialog
          open
          onOpenChange={(open) => !open && setAsk(null)}
          title={channelOffConfirm(CHANNEL_LABEL[ask], ask === 'paper').title}
          confirmLabel="Turn off"
          disabled={replace && !allOff(ask) && Boolean(replaceInfo?.blocked)}
          lines={
            replace && !allOff(ask)
              ? []
              : [channelOffConfirm(CHANNEL_LABEL[ask], ask === 'paper').description as string]
          }
          onConfirm={() => save({ [ask]: 'off' }, replace && !allOff(ask))}
        >
          {replaceInfo && isDigital(ask) ? (
            <ReplaceOption
              supported={replaceInfo.supported}
              allOff={allOff(ask)}
              blocked={replaceInfo.blocked}
              windows={replaceInfo.windows}
              checked={replace}
              onChange={setReplace}
            />
          ) : null}
        </ReviewDialog>
      ) : null}
    </Card>
  );
}
