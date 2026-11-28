import { BENCH_COPY } from '../../../shared/copy/developers-bench.ts';
import './state.css';

/** Widths of the title bar per row, so the rows do not read as a grid of equal bars. */
const WIDTHS = [62, 48, 71, 55, 40, 66, 52, 44];

/**
 * A list loading: rows at the list's own height (40 px, 44 coarse) with the lead, the title and the
 * trail as bars that shimmer (1.3 s; still under reduced motion). Says Loading once. SSR-safe.
 */
export function BenchSkeleton({ rows = 5 }: { rows?: number }) {
  return (
    <div
      className="bench-skel"
      data-loading="content"
      role="status"
      aria-label={BENCH_COPY.loading}
    >
      {Array.from({ length: rows }, (_, i) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: placeholder rows never reorder
        <div key={i} className="bench-skel-r" aria-hidden="true">
          <i className="bench-skel-b" style={{ width: 56 }} />
          <i className="bench-skel-b" style={{ width: `${WIDTHS[i % WIDTHS.length]}%` }} />
          <i className="bench-skel-b" style={{ width: 36, marginInlineStart: 'auto' }} />
        </div>
      ))}
    </div>
  );
}
