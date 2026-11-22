import { formatShortDate } from '../../lib/format.ts';

/** "Date: any", "Oct 1 – Oct 31", "From Oct 1", "To Oct 31". */
export function rangeLabel(from: number | undefined, to: number | undefined): string {
  const day = formatShortDate;
  if (from !== undefined && to !== undefined) return `${day(from)} – ${day(to)}`;
  if (from !== undefined) return `From ${day(from)}`;
  if (to !== undefined) return `To ${day(to)}`;
  return 'any';
}
