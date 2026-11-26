import { Check, TriangleAlert } from 'lucide-react';
import { Button } from '../../../ui/index.ts';
import type { ProbeResult } from './probe-api.ts';

const range = (p: NonNullable<ProbeResult['page']>) => `${p.from}–${p.to}`;

/** Fetches the page after the first and shows that its records do not repeat the first page's. */
export function PageProof({
  first,
  second,
  stale,
  pending,
  onNext,
}: {
  first: ProbeResult | undefined;
  second: ProbeResult | undefined;
  stale: boolean;
  pending: boolean;
  onNext: () => void;
}) {
  const a = first?.page;
  const b = second?.page;
  const canNext = Boolean(a?.next) && !stale;
  let line: React.ReactNode = null;
  if (!first) line = 'Fetch a sample first.';
  else if (stale) line = 'Settings changed. Fetch the sample again.';
  else if (!a?.next && !b)
    line = 'No second page: the sample is the whole list, or pagination is off.';
  else if (b) {
    line =
      b.overlap === 0 ? (
        <span className="rx-proof">
          <Check aria-hidden className="size-4" />
          Records {a ? `${range(a)} · ` : ''}
          {range(b)} · no repeats
          <span aria-hidden className="rx-proof-line" />
        </span>
      ) : (
        <span className="inline-flex items-center gap-1.5 text-warning">
          <TriangleAlert aria-hidden className="size-4" />
          {b.overlap} repeated from page 1. Check the cursor and the ID.
        </span>
      );
  }
  return (
    <div className="flex min-w-0 flex-wrap items-center gap-3">
      <Button
        variant="outline"
        size="sm"
        disabled={!canNext}
        loading={pending && canNext}
        onClick={onNext}
      >
        Fetch page 2
      </Button>
      <p role="status" className="min-w-0 text-sm text-fg-muted">
        {line}
      </p>
    </div>
  );
}
