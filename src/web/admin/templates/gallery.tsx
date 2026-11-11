import { Link } from '@tanstack/react-router';
import type { CSSProperties } from 'react';
import type { TemplateSummaryDto } from '@/shared/contracts/templates.ts';
import { cn } from '../../lib/cn.ts';
import { useArrivalMode } from '../../lib/motion.ts';
import { useOrgScope } from '../../lib/org-filter.tsx';
import { Badge, EntityAvatar, Skeleton } from '../../ui/index.ts';
import { PassPreview } from '../passes/pass-preview.tsx';
import { useTemplatePreview } from './api.ts';

export const originLabel = (origin: string) => (origin === 'baked' ? 'Built-in' : 'Uploaded');

/** The template's sample pass as a still; archived templates show an empty slot. */
export function TemplateStill({
  template,
  deal,
  className,
}: {
  template: TemplateSummaryDto;
  deal?: boolean;
  className?: string;
}) {
  const { orgId } = useOrgScope();
  const live =
    Boolean(orgId) &&
    (template.orgId === null || template.orgId === orgId) &&
    template.status === 'active' &&
    Boolean(template.activeVersion);
  const preview = useTemplatePreview(live ? template.id : '', orgId);
  return (
    // Decorative: inert keeps the pass's own links out of the tab order and the a11y tree.
    <div inert aria-hidden className={cn('pointer-events-none', className)}>
      {live && preview.data ? (
        <PassPreview
          passJson={preview.data.passJson}
          assetBaseUrl={preview.data.assetBaseUrl}
          assetNames={preview.data.assetNames}
          still
          enter={deal}
        />
      ) : live ? (
        <Skeleton className="mx-auto aspect-[320/420] w-full max-w-xs rounded-xl" />
      ) : (
        <div className="mx-auto aspect-[320/420] w-full max-w-xs rounded-xl border border-dashed border-border-strong" />
      )}
    </div>
  );
}

const GRID = 'grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3 2xl:grid-cols-4';
const CARD =
  'relative flex min-w-0 flex-col overflow-hidden rounded-lg border border-border bg-surface-raised shadow-elevation-1';

/** The gallery's card shell and grid, so the page does not jump when the cards arrive. */
export function TemplateGallerySkeleton({ cards = 8 }: { cards?: number }) {
  return (
    <div role="status" aria-busy className={GRID}>
      <span className="sr-only">Loading templates</span>
      {Array.from({ length: cards }, (_, i) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: placeholders have no identity
        <div key={i} className={CARD}>
          <div className="flex justify-center bg-surface-sunken px-8 pt-6 pb-0">
            <Skeleton className="h-48 w-full max-w-44 rounded-b-none rounded-t-xl" />
          </div>
          <div className="flex min-w-0 items-center gap-3 border-t border-border px-4 py-3">
            <Skeleton className="size-6 shrink-0 rounded-full" />
            <div className="grid min-w-0 flex-1 gap-1.5">
              <Skeleton className="h-4 w-2/3" />
              <Skeleton className="h-3 w-1/2" />
            </div>
            <Skeleton className="h-5 w-14 rounded-full" />
          </div>
        </div>
      ))}
    </div>
  );
}

/**
 * Cards: the still on a quiet stage, then name, org monogram and origin. Stills deal in on the
 * first load (60 ms apart); the card chrome rises after them.
 */
export function TemplateGallery({
  items,
  loading,
}: {
  items: TemplateSummaryDto[];
  loading: boolean;
}) {
  const { orgId } = useOrgScope();
  const arrival = useArrivalMode(loading && items.length === 0);
  if (loading && items.length === 0) return <TemplateGallerySkeleton />;
  return (
    <ul aria-label="Templates" className={cn('wl-dim', GRID)}>
      {items.map((t, i) => (
        <li
          key={t.id}
          style={{ '--i': i } as CSSProperties}
          className={cn(
            CARD,
            'wl-colors hover:border-border-strong has-[:focus-visible]:outline-2 has-[:focus-visible]:outline-offset-2 has-[:focus-visible]:outline-focus',
          )}
        >
          <div className="flex justify-center bg-surface-sunken px-8 pt-6 pb-0">
            <TemplateStill
              template={t}
              deal={arrival === 'rise'}
              className="w-full max-w-44 [mask-image:linear-gradient(to_bottom,black_70%,transparent)] max-h-48 overflow-hidden"
            />
          </div>
          <div
            className={cn(
              'flex min-w-0 items-center gap-3 border-t border-border px-4 py-3',
              arrival === 'rise' && 'wl-rise [animation-delay:calc(min(var(--i),6)*60ms+160ms)]',
            )}
          >
            {t.orgId ? (
              <EntityAvatar kind="org" id={t.orgId} name={t.orgName ?? t.name} size={24} />
            ) : (
              <span aria-hidden className="size-6 shrink-0" />
            )}
            <div className="min-w-0 flex-1">
              <Link
                to="/admin/templates/$templateId"
                params={{ templateId: t.id }}
                search={{ orgId }}
                className="block truncate text-sm font-medium text-fg-strong after:absolute after:inset-0 after:content-[''] focus-visible:outline-none"
              >
                {t.name}
              </Link>
              <p className="truncate text-xs text-fg-muted">
                {t.orgName ?? 'All organizations'} · {t.passCount}{' '}
                {t.passCount === 1 ? 'pass' : 'passes'}
              </p>
            </div>
            <Badge>{t.status === 'archived' ? 'Archived' : originLabel(t.origin)}</Badge>
          </div>
        </li>
      ))}
    </ul>
  );
}
