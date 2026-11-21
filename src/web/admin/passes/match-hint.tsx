import type { PassSummaryDto } from '@/shared/contracts/passes.ts';
import { type FindChip, verbOf } from './find-query.ts';

/** The value a chip matched, with the hit marked: "Member ID **M-20**0". */
function Marked({ value, needle }: { value: string; needle: string }) {
  const at = needle ? value.toLowerCase().indexOf(needle.toLowerCase()) : -1;
  if (at < 0) return <>{value}</>;
  return (
    <>
      {value.slice(0, at)}
      <mark className="rounded-sm bg-warning/25 px-0.5 text-fg-strong">
        {value.slice(at, at + needle.length)}
      </mark>
      {value.slice(at + needle.length)}
    </>
  );
}

export function MatchHint({
  matched,
  chips,
  labels,
}: {
  matched: NonNullable<PassSummaryDto['matched']>;
  chips: readonly FindChip[];
  labels: ReadonlyMap<string, string>;
}) {
  const hit = matched[0];
  if (!hit) return null;
  const chip = chips.find((c) => c.k === hit.input);
  return (
    <span className="ml-8 truncate text-xs text-fg-muted" title={chip ? verbOf(chip.o) : undefined}>
      {labels.get(hit.input) ?? hit.input}{' '}
      <Marked value={hit.value} needle={chip && chip.o !== 'is' ? chip.v : (chip?.v ?? '')} />
    </span>
  );
}
