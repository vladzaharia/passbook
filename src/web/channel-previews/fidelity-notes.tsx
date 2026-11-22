import type { FidelityReport, ReportItem } from '@/passkit/wallets/types.ts';
import { PREVIEW_COPY } from '@/shared/copy/previews.ts';
import { Badge } from '../ui/badge.tsx';

function Group({ title, items }: { title: string; items: readonly ReportItem[] }) {
  if (items.length === 0) return null;
  return (
    <div className="flex flex-col gap-2">
      <h4 className="text-sm font-semibold text-fg-strong">
        {title} <span className="font-normal text-fg-muted">({items.length})</span>
      </h4>
      <ul className="flex flex-col divide-y divide-border rounded-lg border border-border bg-surface-raised">
        {items.map((item) => (
          <li
            key={`${item.capability}|${item.path}|${item.message}`}
            className="flex flex-col gap-1 px-3 py-2 text-sm"
          >
            <span className="text-fg [overflow-wrap:anywhere]">{item.message}</span>
            <span className="flex flex-wrap items-center gap-2 text-xs text-fg-muted">
              <span className="[overflow-wrap:anywhere]">{item.path || item.capability}</span>
              {item.chosen ? <Badge tone="neutral">{PREVIEW_COPY.chosen}</Badge> : null}
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}

/** What the wallet leaves out or draws differently, from the release pipeline's own report. */
export function FidelityNotes({ report }: { report: FidelityReport }) {
  const missing = report.items.filter((i) => i.severity !== 'difference');
  const different = report.items.filter((i) => i.severity === 'difference');
  return (
    <div className="flex min-w-0 flex-col gap-4" data-testid="fidelity-notes">
      {missing.length + different.length === 0 ? (
        <p className="text-sm text-fg-muted">{PREVIEW_COPY.allShown}</p>
      ) : null}
      <Group title={PREVIEW_COPY.notShown} items={missing} />
      <Group title={PREVIEW_COPY.different} items={different} />
    </div>
  );
}
