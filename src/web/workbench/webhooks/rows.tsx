import { Send } from 'lucide-react';
import { BENCH_COPY } from '../../../shared/copy/developers-bench.ts';
import { BENCH_WEBHOOKS_COPY } from '../../../shared/copy/developers-bench-webhooks.ts';
import type { BenchRowParts } from '../bench/list.tsx';
import { BenchState } from '../bench/state.tsx';
import { StatusChip } from '../bench/status-chip.tsx';
import { BenchTime } from '../bench/time.tsx';
import { type Row, stateWord, toneOfRow } from './model.ts';

const C = BENCH_WEBHOOKS_COPY;

/** A delivery as a list row: when, what (a Test send says so), the line under it, and the answer. */
export const rowParts = (r: Row): BenchRowParts => ({
  lead: <BenchTime at={r.at} />,
  title: (
    <>
      {r.type}
      {r.kind === 'test' ? <StatusChip tone="neutral">{C.inspector.test}</StatusChip> : null}
    </>
  ),
  meta: r.meta,
  trail: (
    <StatusChip status={r.status} tone={toneOfRow(r)}>
      {r.status ?? stateWord(r)}
    </StatusChip>
  ),
});

/** No rows: the filters match none (clear them), or nothing has arrived (send one). */
export function EmptyList({
  narrowed,
  busy,
  onClear,
  onSend,
}: {
  narrowed: boolean;
  busy: boolean;
  onClear: () => void;
  onSend: () => void;
}) {
  return narrowed ? (
    <BenchState scene="no-match">
      <button type="button" className="btn outline" onClick={onClear}>
        {BENCH_COPY.state.clearFilters}
      </button>
    </BenchState>
  ) : (
    <BenchState scene="webhooks-idle">
      <button type="button" className="btn" disabled={busy} onClick={onSend}>
        <Send aria-hidden="true" />
        {C.send.action}
      </button>
    </BenchState>
  );
}
