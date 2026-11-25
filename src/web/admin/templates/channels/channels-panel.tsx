import { type Dispatch, type SetStateAction, useRef, useState } from 'react';
import type { z } from 'zod';
import { isDigital, orgChain, stoppedAboveOrg } from '@/shared/channels.ts';
import {
  CHANNELS,
  type Channel,
  type PutTemplateChannelsResponseSchema,
  type TemplateChannelState,
} from '@/shared/contracts/channels.ts';
import { CHANNEL_COPY, CHANNEL_LABEL, CHANNEL_STATE_LABEL } from '@/shared/copy/channels.ts';
import { isApiError } from '../../../lib/errors.ts';
import {
  Card,
  CardBody,
  ErrorState,
  SaveBar,
  type SaveResult,
  SegmentedControl,
  SkeletonRows,
  toast,
} from '../../../ui/index.ts';
import { ChainBadge } from '../../brand/chain-badge.tsx';
import { ChannelList, ChannelRow } from '../../channels/channel-row.tsx';
import { usePutTemplateChannels, useTemplateChannels } from './api.ts';
import { ChannelRuns } from './channel-runs.tsx';
import { impactLines } from './impact.ts';
import { ReplaceOption } from './replace-option.tsx';
import { ResetPasses } from './reset-passes.tsx';
import { ReviewDialog } from './review-dialog.tsx';
import { TemplateBrandCard } from './template-brand-card.tsx';

export type ChannelEdits = Partial<Record<Channel, TemplateChannelState>>;
type Draft = ChannelEdits;
type Dry = z.infer<typeof PutTemplateChannelsResponseSchema>;
/** The dry run the review shows, with whether new codes are asked for. */
interface Review {
  dry: Dry;
  replace: boolean;
  /** True while the dry run for a changed tick is on its way. */
  loading: boolean;
}

const OPTIONS = (['on', 'off', 'never'] as const).map((value) => ({
  value,
  label: CHANNEL_STATE_LABEL[value],
}));
/** Choices the template makes itself; every other reason is a limit above it. */
const OWN = new Set(['never', 'template_off']);

/**
 * Template › Channels and brand for the current mode: On, Off (a pass may still turn it on) or Never per
 * channel, each with the chain of levels above it. A channel something above the template blocks
 * shows why and cannot be changed. Reset N passes sends their own choices back to the template. Save
 * asks the server for the effect first and shows it before anything is written.
 */
export function TemplateChannelsPanel({
  templateId,
  orgId,
  canPublish,
  canEdit,
  draft,
}: {
  templateId: string;
  orgId: string;
  canPublish: boolean;
  /** The caller authors this template: Override and Use organization open its designer. */
  canEdit: boolean;
  /** The unsaved choices, kept by the page so a layout switch (which remounts this panel) keeps them. */
  draft?: [Draft, Dispatch<SetStateAction<Draft>>];
}) {
  const query = useTemplateChannels(templateId, orgId);
  const put = usePutTemplateChannels(templateId, orgId);
  /** The newest dry run; an older answer that lands late is dropped. */
  const latest = useRef(0);
  const own = useState<Draft>({});
  const [edits, setEdits] = draft ?? own;
  const [review, setReview] = useState<Review | null>(null);
  const data = query.data;
  if (query.isPending) return <SkeletonRows rows={6} label="Loading channels" />;
  if (query.isError || !data)
    return <ErrorState inline error={query.error} onRetry={() => void query.refetch()} />;

  const stored = (c: Channel): TemplateChannelState => data.channels?.[c] ?? data.defaults[c];
  const value = (c: Channel) => edits[c] ?? stored(c);
  const changed = CHANNELS.filter((c) => value(c) !== stored(c));
  const body = (replace = false) => ({
    channels: Object.fromEntries(changed.map((c) => [c, value(c)])),
    revision: data.revision,
    ...(replace ? { replaceCodes: true } : {}),
  });
  /** Turning a digital channel off or never: the one change that can issue new codes. */
  const turnsOff = changed.some((c) => isDigital(c) && value(c) !== 'on');
  const discard = () => setEdits({});

  const dryRun = (replace = false) => put.mutateAsync({ ...body(replace), dryRun: true });
  const clearedOf = (dry: Dry) => dry.impact.reduce((n, i) => n + i.clearedOverrides, 0);

  async function save(): Promise<SaveResult | undefined> {
    try {
      const dry = await dryRun();
      if (dry.impact.every((i) => i.passes === 0 && i.clearedOverrides === 0))
        await commit(clearedOf(dry));
      else setReview({ dry, replace: false, loading: false });
      return undefined;
    } catch (error) {
      toast.error(error, 'Could not save channels.');
      return 'failed';
    }
  }
  /** Ticking re-asks the server with the box on, so the counts and windows are the ones saved. */
  async function tick(replace: boolean) {
    const mine = ++latest.current;
    setReview((r) => (r ? { ...r, replace, loading: true } : r));
    try {
      const dry = await dryRun(replace);
      if (mine === latest.current) setReview({ dry, replace, loading: false });
    } catch (error) {
      if (mine !== latest.current) return;
      toast.error(error, 'Could not check channels.');
      setReview((r) => (r ? { ...r, replace: !replace, loading: false } : r));
    }
  }
  /** Sends the cleared-override count the user saw; if it moved, shows the new numbers and stops. */
  async function commit(cleared: number, replace = false) {
    try {
      await put.mutateAsync({ ...body(replace), expectedCleared: cleared });
    } catch (error) {
      if (isApiError(error) && error.code === 'TEMPLATE_CHANNELS_IMPACT_CHANGED') {
        setReview({ dry: await dryRun(replace), replace, loading: false });
      }
      void query.refetch();
      throw error;
    }
    setEdits({});
    toast.success(CHANNEL_COPY.saved);
  }

  const replacing = Boolean(review?.replace) && !review?.dry.allOff;
  const refused = replacing && Boolean(review?.dry.blocked);

  return (
    <div className="flex flex-col gap-4">
      <Card>
        <CardBody>
          <ChannelList>
            {CHANNELS.filter((c) => !stoppedAboveOrg(data.levels[c])).map((c) => {
              const status = data.effective[c];
              const limited = !status.on && status.reason !== undefined && !OWN.has(status.reason);
              return (
                <ChannelRow
                  key={c}
                  channel={c}
                  status={status}
                  chain={<ChainBadge levels={orgChain(data.levels[c])} />}
                  locked={limited}
                  control={
                    <SegmentedControl
                      label={CHANNEL_LABEL[c]}
                      options={OPTIONS.map((o) => ({ ...o, disabled: !canPublish }))}
                      value={value(c)}
                      onValueChange={(v) =>
                        setEdits((e) => {
                          const next = { ...e, [c]: v };
                          if (v === stored(c)) delete next[c];
                          return next;
                        })
                      }
                    />
                  }
                />
              );
            })}
          </ChannelList>
        </CardBody>
        <div className="border-t border-border px-4 py-3">
          <ResetPasses
            templateId={templateId}
            orgId={orgId}
            passes={data.overridePasses}
            overrides={data.overrides}
            disabled={changed.length > 0}
            canReset={canPublish}
          />
        </div>
        {canPublish ? (
          <SaveBar
            dirty={changed.length > 0}
            saving={put.isPending}
            paused={put.isPaused}
            onSave={save}
            onDiscard={discard}
          />
        ) : null}
        <ReviewDialog
          open={review !== null}
          onOpenChange={(open) => !open && setReview(null)}
          title="Save channels?"
          confirmLabel="Save"
          disabled={review?.loading || refused}
          lines={review ? impactLines(review.dry.impact, replacing) : []}
          onConfirm={() => commit(review ? clearedOf(review.dry) : 0, replacing)}
        >
          {review && turnsOff ? (
            <ReplaceOption
              supported={review.dry.replaceSupported}
              allOff={review.dry.allOff}
              blocked={review.dry.blocked}
              loading={review.loading}
              windows={review.dry.windows}
              checked={review.replace}
              note={false}
              onChange={(v) => void tick(v)}
            />
          ) : null}
        </ReviewDialog>
      </Card>
      <ChannelRuns templateId={templateId} orgId={orgId} />
      <TemplateBrandCard templateId={templateId} orgId={orgId} canEdit={canEdit} />
    </div>
  );
}
