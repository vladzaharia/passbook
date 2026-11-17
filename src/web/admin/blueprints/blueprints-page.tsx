import { Link } from '@tanstack/react-router';
import { Upload } from 'lucide-react';
import { useMemo, useState } from 'react';
import type { TemplateSummaryDto } from '@/shared/contracts/templates.ts';
import { cn } from '../../lib/cn.ts';
import { useArrivalMode } from '../../lib/motion.ts';
import { useOrgScope } from '../../lib/org-filter.tsx';
import { Button, EmptyState, ErrorState, PageHeader } from '../../ui/index.ts';
import { TemplateGallerySkeleton } from '../templates/gallery.tsx';
import { useBlueprints } from './api.ts';
import { BlueprintTile } from './blueprint-tile.tsx';
import { UseBlueprintDialog } from './use-dialog.tsx';

const GRID = 'grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4';
/** Gallery order: Membership, Poster, the store cards side by side, Coupon, Event, Boarding. */
const RANK: Record<string, number> = {
  generic: 0,
  posterGeneric: 1,
  storeCard: 2,
  coupon: 3,
  eventTicket: 4,
  boardingPass: 5,
};
const rank = (b: TemplateSummaryDto) => b.styles.reduce((r, s) => Math.max(r, RANK[s] ?? 6), 0);

/** Platform designs to start from: read only, one tile each; Use makes a template in an org. */
export function BlueprintsPage() {
  const list = useBlueprints();
  const { orgId, membership } = useOrgScope();
  const canUpload = membership?.capabilities.includes('templates:author') ?? false;
  const items = useMemo(
    () =>
      [...(list.data?.items ?? [])].sort(
        (a, b) => rank(a) - rank(b) || a.name.localeCompare(b.name),
      ),
    [list.data],
  );
  const arrival = useArrivalMode(list.isPending);
  const [using, setUsing] = useState<TemplateSummaryDto | null>(null);
  return (
    <>
      <PageHeader
        title="Blueprints"
        description="Designs to start from. Use one to make a template, then issue passes from it."
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
      ) : items.length === 0 ? (
        <EmptyState art="template" title="No blueprints" />
      ) : (
        <ul aria-label="Blueprints" className={cn('wl-dim', GRID)}>
          {items.map((b, i) => (
            <BlueprintTile
              key={b.id}
              blueprint={b}
              index={i}
              rise={arrival === 'rise'}
              onUse={() => setUsing(b)}
            />
          ))}
        </ul>
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
