import type { CSSProperties } from 'react';
import type { z } from 'zod';
import type { ChangeRunPreviewSchema } from '@/shared/contracts/broadcasts-change.ts';
import { formatCount, formatDateTime } from '../../../lib/format.ts';
import {
  Buddy,
  Callout,
  CountUp,
  LoadingRail,
  Skeleton,
  useDelayed,
  WizardReview,
  type WizardReviewSection,
} from '../../../ui/index.ts';
import { CHANGE_COPY as C } from './copy.ts';
import { Estimate } from './estimate.tsx';
import { refusalText } from './refusal.ts';
import { SampleDiffs } from './sample-diffs.tsx';
import type { ChangeStepId } from './steps.ts';
import type { ChangeWizard } from './use-change-wizard.ts';

type Preview = z.infer<typeof ChangeRunPreviewSchema>;

export const blockedTotal = (p: Preview) => p.blocked.reduce((n, b) => n + b.count, 0);
/** Passes the run would change: the targeted, less those already set and those it can't touch. */
export const willChange = (p: Preview) => Math.max(0, p.targeted - p.unchanged - blockedTotal(p));

/** The tiles beyond 200 passes are scaled from the 200 newest. */
export const SAMPLED_PASSES = 200;

/** The counts are exact (200 passes or fewer) and nothing would change: Run has nothing to do. */
export const exactNothing = (p: Preview) =>
  !(p.estimated === true && p.targeted > SAMPLED_PASSES) && willChange(p) === 0;

function Tile({ label, value, i }: { label: string; value: number; i: number }) {
  return (
    <div
      style={{ '--i': i } as CSSProperties}
      className="flex flex-col-reverse rounded-lg border border-border bg-surface-sunken p-3"
    >
      <dt className="text-xs text-fg-muted">{label}</dt>
      <dd className="text-2xl font-semibold text-fg-strong">
        <CountUp value={value} />
      </dd>
    </div>
  );
}

/** C3: the server's dry run: counts, sample diffs, and a summary with a link back to each choice. */
export function ReviewStep({
  w,
  which,
  picked,
  onEdit,
}: {
  w: ChangeWizard;
  /** A section's Edit: back to that step. */
  onEdit: (id: ChangeStepId) => void;
  which: string;
  /** For Select all matching: the count the person selected. */
  picked: number | undefined;
}) {
  const p = w.preview.data;
  // The last counts stay readable while a re-check runs; a rail along the top says it is.
  const refreshing = useDelayed(w.preview.isFetching && p !== undefined);
  if (!p)
    return w.preview.isError ? (
      <Callout tone="danger">{refusalText(w.preview.error)}</Callout>
    ) : (
      <div role="status" aria-label={C.review.checking} className="flex flex-col gap-3">
        <Skeleton className="h-20" />
        <Skeleton className="h-40" />
      </div>
    );
  const will = willChange(p);
  const tells = w.notify && w.tellable;
  const estimated = p.estimated === true && p.targeted > SAMPLED_PASSES;
  const void_ = w.kind === 'void';
  const startAt = w.startMs !== null ? formatDateTime(w.startMs) : null;
  const sections: WizardReviewSection<ChangeStepId>[] = [
    {
      id: 'change',
      title: C.review.change,
      items: [
        { label: C.review.which, value: which },
        {
          label: C.review.change,
          value: w.kind === 'fields' ? `${C.kinds.fields}: ${w.rows.length}` : C.kinds[w.kind],
        },
        {
          label: C.review.undo,
          value: w.kind === 'design' ? C.run.notUndoable : C.review.undoLine,
        },
      ],
    },
    // A void has no holders step: nobody is told and it starts now.
    ...(void_
      ? []
      : [
          {
            id: 'holders' as const,
            title: C.review.holders,
            items: [
              { label: C.review.holders, value: tells ? C.review.notifyLine : C.review.silentLine },
              { label: C.review.start, value: startAt ?? C.review.startNow },
            ],
          },
        ]),
  ];
  return (
    <div className="relative flex flex-col gap-6" aria-busy={w.preview.isFetching}>
      <LoadingRail show={refreshing} />
      <dl className="wl-stagger grid grid-cols-2 gap-3 sm:grid-cols-4">
        <Tile i={0} label={C.review.willChange} value={will} />
        <Tile i={1} label={C.review.alreadySet} value={p.unchanged} />
        <Tile
          i={2}
          label={tells ? C.review.notified : C.review.silent}
          value={tells ? p.notified : will}
        />
        <Tile i={3} label={C.review.cantChange} value={blockedTotal(p)} />
      </dl>
      {tells ? (
        <Estimate preview={p} />
      ) : estimated ? (
        <p className="text-sm text-fg-muted">{C.review.estimated}</p>
      ) : null}
      {picked !== undefined && p.targeted < picked ? (
        <Callout tone="info">{C.review.ofSelected(p.targeted, picked)}</Callout>
      ) : null}
      {p.blocked.length > 0 ? (
        <Callout
          tone="warning"
          items={p.blocked.map(
            (b) => `${formatCount(b.count)} ${C.review.blocked[b.code] ?? C.review.blockedOther}`,
          )}
        >
          {C.review.cantChange}
        </Callout>
      ) : null}
      {will === 0 && !estimated ? <Callout tone="info">{C.review.nothing}</Callout> : null}
      <section aria-label={C.review.samples} className="flex flex-col gap-2">
        <h3 className="text-sm font-semibold text-fg-strong">{C.review.samples}</h3>
        <SampleDiffs samples={p.samples.slice(0, 5)} />
      </section>
      <div data-art-host="" className="wl-buddy-room relative">
        <Buddy scene="peek" size="sm" at="end" />
        <WizardReview sections={sections} onEdit={onEdit} level={3} />
      </div>
    </div>
  );
}
