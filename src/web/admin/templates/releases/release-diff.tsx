import { ArrowRight } from 'lucide-react';
import type {
  ReleaseDiffGroup,
  ReleaseDiffValue,
} from '@/shared/contracts/template-release-flow.ts';
import { formatColor, formatCount, formatDay, formatMaybeDate } from '../../../lib/format.ts';
import { Badge } from '../../../ui/index.ts';

const GROUP = {
  colors: 'Colors',
  front: 'Front',
  back: 'Back',
  images: 'Images',
  barcode: 'Barcode',
} as const;

function Value({
  value,
  struck,
  image,
}: {
  value: ReleaseDiffValue;
  struck?: boolean;
  image: (v: Extract<ReleaseDiffValue, { type: 'image' }>) => string;
}) {
  const cls = struck ? 'text-fg-muted line-through' : '';
  if (value.type === 'color')
    return (
      <span className={`inline-flex items-center gap-1.5 ${cls}`}>
        <span
          aria-hidden
          className="size-3.5 rounded-full border border-border"
          style={{ background: value.color }}
        />
        <code className="font-mono text-xs">{formatColor(value.color)}</code>
      </span>
    );
  if (value.type === 'image')
    return (
      <img
        src={image(value)}
        alt=""
        className={`h-7 max-w-24 rounded border border-border bg-[#5b6472] object-contain p-0.5 ${struck ? 'opacity-60' : ''}`}
      />
    );
  return (
    <span className={cls}>
      {value.type === 'date' ? formatDay(value.at) : formatMaybeDate(value.text)}
    </span>
  );
}

/** Grouped, typed changes: swatches, thumbnails, Added and Removed. */
export function ReleaseDiff({
  groups,
  image,
}: {
  groups: readonly ReleaseDiffGroup[];
  image: (v: Extract<ReleaseDiffValue, { type: 'image' }>) => string;
}) {
  // An added field with no value says nothing: the pass shows nothing there either.
  const shown = groups
    .map((g) => ({
      ...g,
      rows: g.rows.filter(
        (r) => !(r.kind === 'added' && r.to?.type === 'text' && r.to.text === ''),
      ),
    }))
    .filter((g) => g.rows.length > 0);
  if (!shown.length) return <p className="text-sm text-fg-muted">No visible changes.</p>;
  return (
    <div className="grid gap-4">
      {shown.map((g) => (
        <section key={g.group} aria-label={GROUP[g.group]} className="grid gap-1.5">
          <h3 className="text-xs font-semibold text-fg-muted">{GROUP[g.group]}</h3>
          <ul className="grid gap-1">
            {g.rows.map((row) => (
              <li
                key={`${row.kind}:${row.label}`}
                className="grid grid-cols-[minmax(0,6rem)_minmax(0,1fr)] items-center gap-3 rounded-md bg-surface-sunken px-3 py-2 text-sm"
              >
                <span className="text-fg-muted">{row.label}</span>
                <span className="flex min-w-0 flex-wrap items-center gap-2">
                  {row.kind === 'added' ? <Badge tone="success">Added</Badge> : null}
                  {row.kind === 'removed' ? <Badge tone="warning">Removed</Badge> : null}
                  {row.kind === 'changed' && row.from ? (
                    <>
                      <Value value={row.from} struck image={image} />
                      <ArrowRight aria-hidden className="size-3.5 text-fg-muted" />
                    </>
                  ) : null}
                  {row.kind === 'removed' && row.from ? (
                    <Value value={row.from} struck image={image} />
                  ) : null}
                  {row.kind !== 'removed' && row.to ? <Value value={row.to} image={image} /> : null}
                </span>
              </li>
            ))}
          </ul>
          {g.more > 0 ? (
            <p className="text-xs text-fg-muted">and {formatCount(g.more)} more</p>
          ) : null}
        </section>
      ))}
    </div>
  );
}
