import { Check } from 'lucide-react';
import type { PresetOptionDto } from '@/shared/contracts/entitlement-admin.ts';
import { parseEntitlementValue } from '@/shared/contracts/entitlements.ts';
import {
  CHANNEL_CHIP,
  COMPARE_ROWS,
  CONNECTORS_ALL,
  CONNECTORS_BASIC,
  type CompareRow,
  FOOTER_SAMPLE,
  PLAN_COPY,
  PLAN_PLACES,
} from '@/shared/copy/plans.ts';
import { planFacts } from '@/shared/plan-facts.ts';
import { cn } from '@/web/lib/cn.ts';
import { formatCount, formatDateTime } from '@/web/lib/format.ts';
import { Badge, Sheet, SheetContent } from '@/web/ui/index.ts';
import { planIcon } from './plan-icons.ts';

/** A cell: the text a reader sees and what a screen reader says when that is not the same. */
function Cell({ row, plan }: { row: CompareRow; plan: PresetOptionDto }) {
  const value = parseEntitlementValue(row.key, plan.values[row.key]);
  const off = (
    <>
      <span aria-hidden>{'—'}</span>
      <span className="sr-only">Not included</span>
    </>
  );
  switch (row.kind) {
    case 'flag':
      return value === 1 ? (
        <>
          <Check aria-hidden className="size-4 text-success" />
          <span className="sr-only">Included</span>
        </>
      ) : (
        off
      );
    case 'limit':
      if (value === null) return <>{PLAN_COPY.noLimit}</>;
      return typeof value === 'number' && value > 0 ? formatCount(value) : off;
    case 'nfc': {
      const level = planFacts(plan.values).nfc;
      return level === 'off' ? off : CHANNEL_CHIP.nfc[level];
    }
    case 'connectors':
      if (!Array.isArray(value) || value.length === 0) return off;
      return <>{value.includes('*') ? CONNECTORS_ALL : CONNECTORS_BASIC}</>;
    case 'footer':
      return <>{FOOTER_SAMPLE[planFacts(plan.values).footer]}</>;
  }
}

/** Where PassBook shows, by the footer a plan allows. */
function Places() {
  return (
    <section aria-labelledby="plan-places" className="mt-8 flex flex-col gap-3">
      <h3 id="plan-places" className="text-sm font-semibold text-fg-strong">
        {PLAN_COPY.placesTitle}
      </h3>
      <div className="overflow-x-auto">
        <table className="w-full min-w-[32rem] border-separate border-spacing-0 text-sm">
          <thead>
            <tr>
              <th scope="col" className="p-2 text-left font-medium text-fg-muted">
                <span className="sr-only">Place</span>
              </th>
              {(['full', 'quiet', 'none'] as const).map((l) => (
                <th key={l} scope="col" className="p-2 text-left font-medium text-fg-muted">
                  {PLAN_COPY.footer}: {FOOTER_SAMPLE[l]}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {PLAN_PLACES.map((row) => (
              <tr key={row.place}>
                <th
                  scope="row"
                  className="border-t border-border p-2 text-left font-normal text-fg"
                >
                  {row.place}
                  {row.hint ? (
                    <span className="block text-xs text-fg-muted">{row.hint}</span>
                  ) : null}
                </th>
                {(['full', 'quiet', 'none'] as const).map((l) => (
                  <td key={l} className="border-t border-border p-2 text-fg-strong">
                    {row.by[l].replace('{Org}', 'Org name')}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p className="text-xs text-fg-muted">{PLAN_COPY.placesNote}</p>
    </section>
  );
}

/** Read-only: every plan side by side, the picked one tinted. */
export function PlanCompareSheet({
  plans,
  current,
  picked,
  updatedAt,
  onClose,
}: {
  plans: readonly PresetOptionDto[];
  current: string;
  picked: string;
  updatedAt: number | null;
  onClose: () => void;
}) {
  return (
    <Sheet open onOpenChange={(open) => !open && onClose()}>
      <SheetContent title={PLAN_COPY.compareTitle} className="sm:w-[min(52rem,calc(100%-2rem))]">
        <section
          // biome-ignore lint/a11y/noNoninteractiveTabindex: scrollable region, a keyboard scrolls it sideways
          tabIndex={0}
          aria-label={PLAN_COPY.compareTitle}
          className="overflow-x-auto focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-focus"
        >
          <table className="w-full min-w-[40rem] border-separate border-spacing-0 text-sm">
            <thead>
              <tr>
                <th scope="col" className="sticky left-0 z-10 w-36 bg-surface-raised p-3 text-left">
                  <span className="sr-only">Feature</span>
                </th>
                {plans.map((p) => {
                  const Icon = planIcon(p.preset);
                  return (
                    <th
                      key={p.preset}
                      scope="col"
                      className={cn(
                        'p-3 text-left align-bottom font-semibold text-fg-strong',
                        p.preset === picked && 'bg-accent-subtle',
                      )}
                    >
                      <span className="flex flex-col items-start gap-1">
                        <Icon aria-hidden className="size-5 text-fg-muted" />
                        {p.label}
                        {p.preset === current ? (
                          <Badge tone="accent">{PLAN_COPY.current}</Badge>
                        ) : null}
                      </span>
                    </th>
                  );
                })}
              </tr>
            </thead>
            {COMPARE_ROWS.map((g) => {
              const rows = g.rows;
              return (
                <tbody key={g.group}>
                  <tr>
                    <th
                      scope="colgroup"
                      colSpan={plans.length + 1}
                      className="sticky left-0 bg-surface-sunken px-3 py-1.5 text-left text-xs font-medium text-fg-muted"
                    >
                      {g.group}
                    </th>
                  </tr>
                  {rows.map((r) => (
                    <tr key={r.key}>
                      <th
                        scope="row"
                        className="sticky left-0 z-10 border-b border-border bg-surface-raised p-3 text-left font-normal text-fg"
                      >
                        {r.label}
                      </th>
                      {plans.map((p) => (
                        <td
                          key={p.preset}
                          className={cn(
                            'border-b border-border p-3 tabular-nums text-fg-strong',
                            p.preset === picked && 'bg-accent-subtle',
                          )}
                        >
                          <span className="flex items-center gap-1">
                            <Cell row={r} plan={p} />
                          </span>
                        </td>
                      ))}
                    </tr>
                  ))}
                </tbody>
              );
            })}
          </table>
        </section>
        <Places />
        {updatedAt === null ? null : (
          <p className="mt-6 border-t border-border pt-3 text-xs text-fg-muted">
            {PLAN_COPY.updated(formatDateTime(updatedAt))}
          </p>
        )}
      </SheetContent>
    </Sheet>
  );
}
