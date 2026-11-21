import type { CSSProperties } from 'react';
import type { z } from 'zod';
import type { ChangeRunPreviewSchema } from '@/shared/contracts/broadcasts-change.ts';
import {
  Buddy,
  Button,
  Callout,
  Card,
  CardBody,
  CardHeader,
  CountUp,
  Skeleton,
} from '../../../ui/index.ts';
import { CHANGE_COPY as C } from './copy.ts';
import { Estimate } from './estimate.tsx';
import { SampleDiffs } from './sample-diffs.tsx';
import type { ChangeWizard } from './use-change-wizard.ts';

type Preview = z.infer<typeof ChangeRunPreviewSchema>;

export const blockedTotal = (p: Preview) => p.blocked.reduce((n, b) => n + b.count, 0);
/** Passes the run would change: the targeted, less those already set and those it can't touch. */
export const willChange = (p: Preview) => Math.max(0, p.targeted - p.unchanged - blockedTotal(p));

function Tile({ label, value, i }: { label: string; value: number; i: number }) {
  return (
    <div
      style={{ '--i': i } as CSSProperties}
      className="rounded-lg border border-border bg-surface-sunken p-3"
    >
      <dd className="text-2xl font-semibold text-fg-strong">
        <CountUp value={value} />
      </dd>
      <dt className="text-xs text-fg-muted">{label}</dt>
    </div>
  );
}

/** C3: the server's dry run: counts, sample diffs, and a summary with a link back to each choice. */
export function ReviewStep({ w, orgName }: { w: ChangeWizard; orgName: string }) {
  const p = w.preview.data;
  if (!p)
    return w.preview.isError ? (
      <Callout tone="danger">{w.preview.error.message}</Callout>
    ) : (
      <div role="status" aria-label={C.review.checking} className="flex flex-col gap-3">
        <Skeleton className="h-20" />
        <Skeleton className="h-40" />
      </div>
    );
  const will = willChange(p);
  const tells = w.notify && w.tellable;
  return (
    <div className="flex flex-col gap-6">
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
      {tells ? <Estimate preview={p} /> : null}
      {p.blocked.length > 0 ? (
        <Callout
          tone="warning"
          items={p.blocked.map(
            (b) =>
              `${b.count.toLocaleString('en-US')} ${C.review.blocked[b.code] ?? C.review.blockedOther}`,
          )}
        >
          {C.review.cantChange}
        </Callout>
      ) : null}
      {will === 0 ? <Callout tone="info">{C.review.nothing}</Callout> : null}
      <section aria-label={C.review.samples} className="flex flex-col gap-2">
        <h3 className="text-sm font-semibold text-fg-strong">{C.review.samples}</h3>
        <SampleDiffs samples={p.samples.slice(0, 5)} />
      </section>
      <Card>
        <CardHeader title={C.review.summary} />
        <CardBody>
          <dl className="grid gap-3 text-sm">
            {[
              [C.review.which, `${C.passes(p.targeted)} in ${orgName}`, 0],
              [
                C.review.change,
                w.kind === 'fields' ? `${C.kinds.fields}: ${w.rows.length}` : C.kinds[w.kind],
                0,
              ],
              [C.review.holders, tells ? C.review.notifyLine : C.review.silentLine, 1],
              [C.review.undo, w.kind === 'design' ? C.run.notUndoable : C.review.undoLine, -1],
            ].map(([label, value, to]) => (
              <div key={String(label)} className="flex items-baseline justify-between gap-3">
                <dt className="text-fg-muted">{label}</dt>
                <dd className="flex items-baseline gap-3 text-fg-strong">
                  {value}
                  {Number(to) >= 0 ? (
                    <Button
                      size="sm"
                      variant="ghost"
                      aria-label={`${C.review.edit} ${String(label).toLowerCase()}`}
                      onClick={() => w.setStep(Number(to))}
                    >
                      {C.review.edit}
                    </Button>
                  ) : null}
                </dd>
              </div>
            ))}
          </dl>
        </CardBody>
      </Card>
      <div className="flex justify-end" aria-hidden>
        <Buddy scene="peek" size="sm" />
      </div>
    </div>
  );
}
