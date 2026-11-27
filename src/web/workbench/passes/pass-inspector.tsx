import type { PassSummaryDto } from '@/shared/contracts/passes.ts';
import { WB_PASSES } from '@/shared/copy/workbench-passes.ts';
import { DevicesTab } from '../../admin/passes/detail/devices-tab.tsx';
import { VersionsTab } from '../../admin/passes/detail/versions-tab.tsx';
import { PassPreviewPanel } from '../../admin/passes/pass-preview.tsx';
import { Buddy } from '../../ui/art/buddy.tsx';
import { Skeleton } from '../../ui/skeleton.tsx';
import { IdChip } from '../bench/id-chip.tsx';
import { Inspector } from '../bench/inspector.tsx';
import { StatusChip } from '../bench/status-chip.tsx';
import { BenchTime } from '../bench/time.tsx';
import { ToolFailed } from '../states/states.tsx';
import { CallsTab } from './calls-tab.tsx';
import { PassEventsTab } from './events-tab.tsx';
import { moodOf, type PassTab, stateOf, TABS, titleOf, toneOf } from './model.ts';
import { PassActions } from './pass-actions.tsx';
import { usePassDetail } from './use-passes.ts';

const SCENE = { sad: 'tear', happy: 'cheer', flat: 'beat', curious: 'beat' } as const;

/**
 * One pass, the root object (design §3.1): its card on a stage, what to do with it, then its events,
 * devices, versions and calls. The trail, devices and versions are admin's pass-detail components,
 * flat. The buddy's mood is the pass's: sorry when voided, glad for what this tab just did.
 */
export function PassInspector({
  pass,
  orgId,
  sandbox,
  tab,
  onTab,
  cheering,
  onCheer,
  onPrev,
  onNext,
}: {
  pass: PassSummaryDto;
  orgId: string;
  sandbox: boolean;
  tab: PassTab;
  onTab: (tab: PassTab) => void;
  cheering: boolean;
  onCheer: () => void;
  onPrev?: (() => void) | undefined;
  onNext?: (() => void) | undefined;
}) {
  const detail = usePassDetail(pass.id);
  const full = detail.data;
  const title = titleOf(pass);
  const state = stateOf(full ?? pass);
  const mood = moodOf(full ?? pass, cheering);
  const caption =
    mood === 'sad' ? WB_PASSES.status[state] : cheering ? WB_PASSES.simulate.done : '';

  const stage = full ? (
    <>
      <section className="wb-pass-stage" aria-label={WB_PASSES.stage.label(title)}>
        <PassPreviewPanel
          passJson={full.passJson}
          assetBaseUrl={full.assetBaseUrl}
          assetNames={full.assetNames}
          testBand={full.testPreview}
          dim={full.status !== 'active'}
          removed={full.removedAt !== null}
          enter
          mint={full.version}
          seat
          swapKey={full.version}
          label={`v${full.version}`}
          beside={
            <Buddy
              key={`${pass.id}:${mood}`}
              size="sm"
              at="end"
              mood={mood}
              scene={SCENE[mood]}
              className="wl-pass-buddy"
            />
          }
        />
        <span role="status" className="sr-only">
          {caption}
        </span>
      </section>
      <PassActions pass={full} orgId={orgId} sandbox={sandbox} onDone={onCheer} />
    </>
  ) : detail.isError ? (
    <ToolFailed error={detail.error} onRetry={() => void detail.refetch()} />
  ) : (
    <Skeleton className="h-72 w-full" />
  );

  return (
    <Inspector
      title={title}
      label={`Pass ${title}`}
      itemKey={pass.id}
      status={<StatusChip tone={toneOf(full ?? pass)}>{WB_PASSES.status[state]}</StatusChip>}
      id={<IdChip id={pass.id} kind="pass" prefix="pass" />}
      facts={
        <>
          <span>v{pass.version}</span>
          <BenchTime at={pass.modifiedAt} mode="full" />
        </>
      }
      stage={stage}
      tabs={TABS}
      tab={tab}
      onTab={(id) => onTab(id as PassTab)}
      onPrev={onPrev}
      onNext={onNext}
    >
      {full ? (
        tab === 'events' ? (
          <PassEventsTab pass={full} orgId={orgId} />
        ) : tab === 'devices' ? (
          <DevicesTab pass={full} active flat />
        ) : tab === 'versions' ? (
          <VersionsTab pass={full} flat />
        ) : (
          <CallsTab orgId={orgId} passId={pass.id} />
        )
      ) : (
        <Skeleton className="h-24 w-full" />
      )}
    </Inspector>
  );
}
