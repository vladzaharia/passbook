import type { ChannelStatus } from '@/shared/contracts/channels.ts';
import { CHANNEL_COPY } from '@/shared/copy/channels.ts';
import {
  Card,
  CardBody,
  CardHeader,
  ErrorState,
  SkeletonRows,
  Switch,
  toast,
} from '../../ui/index.ts';
import { useSaveSettings, useSettings } from '../settings/queries.ts';
import { ChannelList, ChannelRow } from './channel-row.tsx';

const ON: ChannelStatus = { on: true, source: 'platform' };
const OFF = (reason: NonNullable<ChannelStatus['reason']>): ChannelStatus => ({
  on: false,
  source: 'platform',
  reason,
});

function useSettingsSave(scope: string) {
  const save = useSaveSettings(scope);
  return {
    pending: save.isPending,
    save: (values: Record<string, unknown>) =>
      save.mutate(values, {
        onSuccess: () => toast.success(CHANNEL_COPY.saved),
        onError: (error) => toast.error(error, 'Could not save channels.'),
      }),
  };
}

/** Platform: Paper, the Google and Samsung release state, and Apple phone tap on its own. */
export function PlatformChannelsCards() {
  const query = useSettings('platform');
  const { save, pending } = useSettingsSave('platform');
  const value = (key: string) => query.data?.items.find((i) => i.key === key)?.value === true;
  const released = query.data?.released;
  const paperOn = value('print.enabled');
  const tapOn = value('nfc.enabled');
  const tagsOn = value('nfc.tagsEnabled');
  if (query.isPending) return <SkeletonRows rows={4} label="Loading channels" />;
  if (query.isError)
    return <ErrorState inline error={query.error} onRetry={() => void query.refetch()} />;
  return (
    <>
      <Card>
        <CardHeader title={CHANNEL_COPY.platformCard} />
        <CardBody>
          <ChannelList>
            <ChannelRow
              channel="paper"
              status={paperOn ? ON : OFF('printing_off')}
              control={
                <Switch
                  aria-label={CHANNEL_COPY.paperPlatform}
                  checked={paperOn}
                  disabled={pending}
                  onCheckedChange={(on) => save({ 'print.enabled': on })}
                />
              }
            />
            <ChannelRow
              channel="nfc"
              status={tagsOn ? ON : OFF('tags_off')}
              control={
                <Switch
                  aria-label={CHANNEL_COPY.tagsPlatform}
                  checked={tagsOn}
                  disabled={pending}
                  onCheckedChange={(on) => save({ 'nfc.tagsEnabled': on })}
                />
              }
            />
            {(['google', 'samsung'] as const).map((c) => (
              <ChannelRow
                key={c}
                channel={c}
                status={released?.[c] ? ON : OFF('not_released')}
                locked
              />
            ))}
          </ChannelList>
        </CardBody>
      </Card>
      <Card>
        <CardBody>
          <ChannelList>
            <ChannelRow
              channel="apple"
              label={CHANNEL_COPY.appleTap}
              status={tapOn ? ON : OFF('not_released')}
              reasonText={CHANNEL_COPY.appleTapWaiting}
              control={
                <Switch
                  aria-label={CHANNEL_COPY.appleTap}
                  checked={tapOn}
                  disabled={pending}
                  onCheckedChange={(on) => save({ 'nfc.enabled': on })}
                />
              }
            />
          </ChannelList>
        </CardBody>
      </Card>
    </>
  );
}
