import { useState } from 'react';
import { templateDefault } from '@/shared/channels.ts';
import { CHANNELS, type Channel, type TemplateChannelState } from '@/shared/contracts/channels.ts';
import {
  CHANNEL_COPY,
  CHANNEL_LABEL,
  CHANNEL_STATE_LABEL,
  channelBlocked,
} from '@/shared/copy/channels.ts';
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
  const [review, setReview] = useState<string[] | null>(null);
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

  async function save(): Promise<SaveResult | undefined> {
    try {
      const dry = await put.mutateAsync({ ...body(), dryRun: true });
      const lines = impactLines(dry.impact);
      if (dry.impact.every((i) => i.passes === 0 && i.clearedOverrides === 0)) await commit();
      else setReview(lines);
      return undefined;
    } catch (error) {
      toast.error(error, 'Could not save channels.');
      return 'failed';
    }
  }
  async function commit() {
    try {
      await put.mutateAsync(body());
      setEdits({});
      toast.success(CHANNEL_COPY.saved);
    } catch (error) {
      toast.error(error, 'Could not save channels.');
      void query.refetch();
    }
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
                    <p className="text-xs text-fg-muted">
                      {channelBlocked(c, status.reason, status.source)}
                    </p>
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
            {review?.map((line) => (
              <li key={line}>{line}</li>
            ))}
          </ul>
        }
        onConfirm={commit}
      />
    </Card>
  );
}
