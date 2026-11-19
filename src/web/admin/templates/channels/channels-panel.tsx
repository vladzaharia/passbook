import { useState } from 'react';
import { templateDefault } from '@/shared/channels.ts';
import { CHANNELS, type Channel, type TemplateChannelState } from '@/shared/contracts/channels.ts';
import {
  CHANNEL_COPY,
  CHANNEL_LABEL,
  CHANNEL_STATE_LABEL,
  channelBlocked,
} from '@/shared/copy/channels.ts';
import { isApiError } from '../../../lib/errors.ts';
import {
  Card,
  CardBody,
  ConfirmDialog,
  ErrorState,
  SaveBar,
  type SaveResult,
  SegmentedControl,
  SkeletonRows,
  toast,
} from '../../../ui/index.ts';
import { usePutTemplateChannels, useTemplateChannels } from './api.ts';
import { impactLines } from './impact.ts';

type Draft = Partial<Record<Channel, TemplateChannelState>>;

const OPTIONS = (['on', 'off', 'never'] as const).map((value) => ({
  value,
  label: CHANNEL_STATE_LABEL[value],
}));
/** Choices the template makes itself; every other reason is a limit above it. */
const OWN = new Set(['never', 'template_off']);

/**
 * Template › Channels for the current mode: On, Off (a pass may still turn it on) or Never per
 * channel. A channel something above the template blocks shows why and cannot be changed. Save
 * asks the server for the effect first and shows it before anything is written.
 */
export function TemplateChannelsPanel({
  templateId,
  orgId,
  canPublish,
}: {
  templateId: string;
  orgId: string;
  canPublish: boolean;
}) {
  const query = useTemplateChannels(templateId, orgId);
  const put = usePutTemplateChannels(templateId, orgId);
  const [edits, setEdits] = useState<Draft>({});
  const [review, setReview] = useState<{ lines: string[]; cleared: number } | null>(null);
  const data = query.data;
  if (query.isPending) return <SkeletonRows rows={6} label="Loading channels" />;
  if (query.isError || !data)
    return <ErrorState inline error={query.error} onRetry={() => void query.refetch()} />;

  const stored = (c: Channel): TemplateChannelState => data.channels?.[c] ?? templateDefault(c);
  const value = (c: Channel) => edits[c] ?? stored(c);
  const changed = CHANNELS.filter((c) => value(c) !== stored(c));
  const body = () => ({
    channels: Object.fromEntries(changed.map((c) => [c, value(c)])),
    revision: data.revision,
  });
  const discard = () => setEdits({});

  const dryRun = () => put.mutateAsync({ ...body(), dryRun: true });
  const clearedOf = (dry: Awaited<ReturnType<typeof dryRun>>) =>
    dry.impact.reduce((n, i) => n + i.clearedOverrides, 0);

  async function save(): Promise<SaveResult | undefined> {
    try {
      const dry = await dryRun();
      if (dry.impact.every((i) => i.passes === 0 && i.clearedOverrides === 0))
        await commit(clearedOf(dry));
      else setReview({ lines: impactLines(dry.impact), cleared: clearedOf(dry) });
      return undefined;
    } catch (error) {
      toast.error(error, 'Could not save channels.');
      return 'failed';
    }
  }
  /** Sends the cleared-override count the user saw; if it moved, shows the new numbers and stops. */
  async function commit(cleared: number) {
    try {
      await put.mutateAsync({ ...body(), expectedCleared: cleared });
    } catch (error) {
      if (isApiError(error) && error.code === 'TEMPLATE_CHANNELS_IMPACT_CHANGED') {
        const dry = await dryRun();
        setReview({ lines: impactLines(dry.impact), cleared: clearedOf(dry) });
      }
      void query.refetch();
      throw error;
    }
    setEdits({});
    toast.success(CHANNEL_COPY.saved);
  }

  return (
    <Card>
      <CardBody>
        <ul className="divide-y divide-border">
          {CHANNELS.map((c) => {
            const status = data.effective[c];
            const blocked = !status.on && status.reason !== undefined && !OWN.has(status.reason);
            return (
              <li
                key={c}
                className="flex flex-col items-start gap-2 py-3 sm:flex-row sm:items-center sm:justify-between sm:gap-4"
              >
                <div className="min-w-0">
                  <p className="text-sm font-medium text-fg-strong">{CHANNEL_LABEL[c]}</p>
                  {blocked && status.reason ? (
                    <p className="text-xs text-fg-muted">{channelBlocked(status.reason)}</p>
                  ) : null}
                </div>
                <SegmentedControl
                  label={CHANNEL_LABEL[c]}
                  options={OPTIONS.map((o) => ({
                    ...o,
                    disabled: blocked || !canPublish,
                  }))}
                  value={value(c)}
                  onValueChange={(v) =>
                    setEdits((e) => {
                      const next = { ...e, [c]: v };
                      if (v === stored(c)) delete next[c];
                      return next;
                    })
                  }
                />
              </li>
            );
          })}
        </ul>
      </CardBody>
      {canPublish ? (
        <SaveBar
          dirty={changed.length > 0}
          saving={put.isPending}
          paused={put.isPaused}
          onSave={save}
          onDiscard={discard}
        />
      ) : null}
      <ConfirmDialog
        open={review !== null}
        onOpenChange={(open) => !open && setReview(null)}
        title="Save channels?"
        confirmLabel="Save"
        description={
          <ul className="flex flex-col gap-1">
            {review?.lines.map((line) => (
              <li key={line}>{line}</li>
            ))}
          </ul>
        }
        onConfirm={() => commit(review?.cleared ?? 0)}
      />
    </Card>
  );
}
