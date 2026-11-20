import { CHANNELS, type Channel, type ChannelStatus } from '@/shared/contracts/channels.ts';
import { CHANNEL_COPY, CHANNEL_LABEL } from '@/shared/copy/channels.ts';
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

/** Org: block a channel for every template, and turn NFC tags on or off. */
export function OrgChannelsCard({ orgId }: { orgId: string }) {
  const scope = `org:${orgId}`;
  const query = useSettings(scope);
  const { save, pending } = useSettingsSave(scope);
  const item = (key: string) => query.data?.items.find((i) => i.key === key);
  const blocked = (item('channels.blocked')?.value as Channel[] | undefined) ?? [];
  const tags = item('nfc.tags');
  const tagsOn = (tags?.value as { enabled?: boolean } | undefined)?.enabled === true;
  const status = (c: Channel): ChannelStatus => {
    if (blocked.includes(c)) return { on: false, source: 'org', reason: 'blocked' };
    if (c === 'nfc' && tags?.blockedByPlatform) return OFF('printing_off');
    if (c === 'nfc' && !tagsOn) return { on: false, source: 'org', reason: 'tags_off' };
    return { on: true, source: 'org' };
  };
  const toggle = (c: Channel, on: boolean) => {
    const next = on ? blocked.filter((b) => b !== c) : [...blocked, c];
    save({
      'channels.blocked': next,
      ...(c === 'nfc' && on && !tagsOn ? { 'nfc.tags': { enabled: true } } : {}),
      ...(c === 'nfc' && !on && tagsOn ? { 'nfc.tags': { enabled: false } } : {}),
    });
  };
  return (
    <Card>
      <CardHeader title={CHANNEL_COPY.orgCard} />
      <CardBody>
        {query.isPending ? (
          <SkeletonRows rows={6} label="Loading channels" />
        ) : query.isError ? (
          <ErrorState inline error={query.error} onRetry={() => void query.refetch()} />
        ) : (
          <>
            <ChannelList>
              {CHANNELS.map((c) => {
                const s = status(c);
                return (
                  <ChannelRow
                    key={c}
                    channel={c}
                    status={s}
                    locked={c === 'nfc' && tags?.blockedByPlatform === true}
                    control={
                      <Switch
                        aria-label={`${CHANNEL_LABEL[c]} allowed`}
                        checked={s.on}
                        disabled={pending || (c === 'nfc' && tags?.blockedByPlatform === true)}
                        onCheckedChange={(on) => toggle(c, on)}
                      />
                    }
                  />
                );
              })}
            </ChannelList>
            <p className="mt-3 text-xs text-fg-muted">{CHANNEL_COPY.orgNote}</p>
          </>
        )}
      </CardBody>
    </Card>
  );
}

/** Platform: Paper, the Google and Samsung release state, and Apple phone tap on its own. */
export function PlatformChannelsCards() {
  const query = useSettings('platform');
  const { save, pending } = useSettingsSave('platform');
  const value = (key: string) => query.data?.items.find((i) => i.key === key)?.value === true;
  const released = query.data?.released;
  const paperOn = value('print.enabled');
  const tapOn = value('nfc.enabled');
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
        <CardHeader title={CHANNEL_COPY.appleTap} />
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
