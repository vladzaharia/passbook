import { ArrowRight } from 'lucide-react';
import { useState } from 'react';
import { IMPACT_LABEL, IMPACT_ORDER, NO_FEATURE_CHANGE } from '@/shared/copy/entitlement-admin.ts';
import { ENTITLEMENT_LABEL } from '@/shared/copy/entitlements.ts';
import type { EntitlementImpact, ImpactKind } from '@/shared/entitlement-impact.ts';
import { Badge, Button } from '@/web/ui/index.ts';
import { formatValue } from './values.ts';

const TONE: Record<ImpactKind, 'warning' | 'success' | 'neutral'> = {
  off: 'warning',
  down: 'warning',
  on: 'success',
  up: 'success',
  changed: 'neutral',
};

/** Counts of what a change turns off, lowers, turns on and raises; empty says so. */
export function ImpactSummary({ impact }: { impact: EntitlementImpact }) {
  const shown = IMPACT_ORDER.filter((k) => impact.counts[k] > 0);
  if (shown.length === 0) return <p className="text-sm text-fg-muted">{NO_FEATURE_CHANGE}</p>;
  return (
    <ul aria-label="Impact" className="flex flex-wrap items-center gap-2">
      {shown.map((kind) => (
        <li key={kind}>
          <Badge tone={TONE[kind]}>{IMPACT_LABEL[kind](impact.counts[kind])}</Badge>
        </li>
      ))}
    </ul>
  );
}

const FIRST = 5;

/** Each feature that moves: its name, then the old value and the new one. Long lists fold. */
export function ImpactList({ impact }: { impact: EntitlementImpact }) {
  const [all, setAll] = useState(false);
  const rows = all ? impact.changes : impact.changes.slice(0, FIRST);
  if (impact.changes.length === 0) return null;
  return (
    <div className="flex flex-col gap-2">
      <ul aria-label="What changes" className="flex flex-col divide-y divide-border text-sm">
        {rows.map((c) => (
          <li
            key={c.key}
            className="flex flex-wrap items-center justify-between gap-x-4 gap-y-1 py-2 first:pt-0 last:pb-0"
          >
            <span className="text-fg-strong">{ENTITLEMENT_LABEL[c.key]}</span>
            <span className="flex min-w-0 items-center gap-2 text-fg-muted">
              <span className="break-all line-through decoration-fg-subtle">
                {formatValue(c.key, c.from)}
              </span>
              <ArrowRight aria-hidden className="size-3.5 shrink-0" />
              <span className="break-all text-fg-strong">{formatValue(c.key, c.to)}</span>
            </span>
          </li>
        ))}
      </ul>
      {impact.changes.length > FIRST ? (
        <Button
          variant="ghost"
          size="sm"
          className="self-start"
          onClick={() => setAll((open) => !open)}
        >
          {all ? 'Show fewer' : `Show all ${impact.changes.length}`}
        </Button>
      ) : null}
    </div>
  );
}
