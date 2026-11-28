import { Link } from '@tanstack/react-router';
import { Upload } from 'lucide-react';
import { useDeferredValue, useMemo, useState } from 'react';
import type { TemplateSummaryDto } from '@/shared/contracts/templates.ts';
import { pluralize } from '@/web/lib/format.ts';
import { useArrivalMode } from '../../lib/motion.ts';
import { useOrgScope } from '../../lib/org-filter.tsx';
import { Buddy, Button, EmptyState, ErrorState, FilterBar, PageHeader } from '../../ui/index.ts';
import { TemplateGallerySkeleton } from '../templates/gallery.tsx';
import { useBlueprints } from './api.ts';
import { BlueprintTile } from './blueprint-tile.tsx';
import { entriesOf, groupEntries, matches } from './gallery-model.ts';
import { UseBlueprintDialog } from './use-dialog.tsx';

const GRID =
  'grid grid-cols-2 gap-3 sm:gap-4 max-sm:[&>:last-child:nth-child(odd)]:col-span-2';

const COLS = {
  md: ['', '', 'md:grid-cols-2', 'md:grid-cols-3', 'md:grid-cols-4'],
  lg: ['', '', 'lg:grid-cols-2', 'lg:grid-cols-3', 'lg:grid-cols-4'],
  xl: ['', '', 'xl:grid-cols-2', 'xl:grid-cols-3', 'xl:grid-cols-4'],
} as const;

/** Columns that fill every row: all tiles in one row when few, else the count with the least empty cells. */
function fit(count: number, max: number): number {
  if (count <= max) return Math.max(count, 2);
  let best = max;
  for (let c = max - 1; c >= 3; c--) if (count % c < count % best) best = c;
  return best;
}

export function gridFor(count: number): string {
  return `${GRID} ${COLS.md[fit(count, 4)]} ${COLS.lg[fit(count, 3)]} ${COLS.xl[fit(count, 4)]}`;
}

/**
 * Platform designs to start from, grouped by the job they do. Read only: Use makes a tracked
 * template in an org. The buddy sits on the search field, and is sorry when nothing matches.
 */
export function BlueprintsPage() {
  const list = useBlueprints();
  const { orgId, membership } = useOrgScope();
  const canUpload = membership?.capabilities.includes('templates:author') ?? false;
  const [query, setQuery] = useState('');
  const asked = useDeferredValue(query);
  const entries = useMemo(() => entriesOf(list.data?.items ?? []), [list.data]);
  const shown = useMemo(() => entries.filter((e) => matches(e, asked)), [entries, asked]);
  const groups = useMemo(() => groupEntries(shown), [shown]);
  const arrival = useArrivalMode(list.isPending);
  const [using, setUsing] = useState<TemplateSummaryDto | null>(null);
  const none = entries.length > 0 && shown.length === 0;
  let index = 0;
  return (
    <>
      <PageHeader
        title="Blueprints"
        actions={
          canUpload ? (
            <Button asChild variant="outline" iconStart={<Upload aria-hidden />}>
              <Link to="/admin/templates/upload" search={{ orgId }}>
                Upload template
              </Link>
            </Button>
          ) : undefined
        }
      />
      {list.isError ? (
        <ErrorState
          error={list.error}
          title="Could not load blueprints"
          onRetry={() => void list.refetch()}
        />
      ) : list.isPending ? (
        <TemplateGallerySkeleton cards={7} />
      ) : entries.length === 0 ? (
        <EmptyState art="template" title="No blueprints" />
      ) : (
        <>
          <div data-art-host="" className="wl-buddy-room relative mb-6 pt-2 sm:w-72">
            <Buddy
              size="sm"
              at="end"
              mood={none ? 'sad' : 'happy'}
              scene={none ? 'sorry' : 'peek'}
            />
            <FilterBar
              className="mb-0"
              filters={[]}
              onClear={() => setQuery('')}
              search={{ value: query, onChange: setQuery, placeholder: 'Search blueprints' }}
            />
          </div>
          <p role="status" className="sr-only">
            {pluralize(shown.length, 'blueprint')}
          </p>
          {none ? (
            <EmptyState inline art="template" title="No blueprints match" />
          ) : (
            <div className="grid gap-8">
              {groups.map((g) => (
                <section key={g.id} aria-labelledby={`bp-group-${g.id}`}>
                  <h2
                    id={`bp-group-${g.id}`}
                    className="mb-3 flex items-baseline gap-2 text-sm font-semibold text-fg-strong"
                  >
                    {g.label}
                    <span className="text-xs font-normal text-fg-muted">{g.entries.length}</span>
                  </h2>
                  <ul aria-label={g.label} className={`wl-dim ${gridFor(g.entries.length)}`}>
                    {g.entries.map((entry) => (
                      <BlueprintTile
                        key={entry.id}
                        entry={entry}
                        index={index++}
                        rise={arrival === 'rise'}
                        onUse={setUsing}
                      />
                    ))}
                  </ul>
                </section>
              ))}
            </div>
          )}
        </>
      )}
      {using ? (
        <UseBlueprintDialog
          key={using.id}
          blueprint={using}
          open
          onOpenChange={(open) => !open && setUsing(null)}
        />
      ) : null}
    </>
  );
}
