import { PASS_SELECTION_MAX } from '@/shared/contracts/pass-selection.ts';
import { formatCount as n } from '../../lib/format.ts';
import { Button } from '../../ui/index.ts';

/**
 * Under the bar once every row on screen is ticked and more match: offers all of them. Past the
 * most one run covers, it says to narrow instead.
 */
export function SelectAllBanner({
  count,
  shown,
  all,
  onAll,
  onClear,
}: {
  count: number;
  shown: number;
  all: boolean;
  onAll: () => void;
  onClear: () => void;
}) {
  if (all)
    return (
      <p
        role="status"
        className="wl-find-banner mb-3 flex flex-wrap items-center justify-center gap-3 rounded-md border border-accent bg-accent-subtle px-3 py-2 text-sm"
      >
        <b className="font-semibold">All {n(count)} matching selected</b>
        <Button variant="link" onClick={onClear}>
          Clear
        </Button>
      </p>
    );
  if (count <= shown) return null;
  return (
    <p
      role="status"
      className="wl-find-banner mb-3 flex flex-wrap items-center justify-center gap-x-3 rounded-md border border-border bg-surface-sunken px-3 py-2 text-sm"
    >
      <span>
        {n(shown)} selected.{' '}
        {count > PASS_SELECTION_MAX
          ? `${n(count)} match. Narrow to ${n(PASS_SELECTION_MAX)} to select all.`
          : null}
      </span>
      {count <= PASS_SELECTION_MAX ? (
        <Button variant="link" onClick={onAll}>
          Select all {n(count)} matching
        </Button>
      ) : null}
    </p>
  );
}

/** On a phone the table has no header checkbox: this ticks every row on screen, then the banner offers all. */
export function SelectAllPhone({ onSelect }: { onSelect: () => void }) {
  return (
    <div className="mb-3 md:hidden">
      <Button variant="ghost" className="-ml-3" onClick={onSelect}>
        Select all
      </Button>
    </div>
  );
}
