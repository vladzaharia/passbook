import { Link } from '@tanstack/react-router';
import type { CSSProperties } from 'react';
import type { TemplateSummaryDto } from '@/shared/contracts/templates.ts';
import { cn } from '../../lib/cn.ts';
import { useArrivalMode } from '../../lib/motion.ts';
import { useOrgScope } from '../../lib/org-filter.tsx';
import { Badge, EntityAvatar, Skeleton } from '../../ui/index.ts';
import { OrgMark } from '../../ui/layout/scope-switcher.tsx';
import { PassPreview } from '../passes/pass-preview.tsx';
import { displayName } from '../passes/template-groups.ts';
import { useTemplate, useTemplatePreview } from './api.ts';

export const originLabel = (origin: string) => (origin === 'baked' ? 'Built-in' : 'Uploaded');

/**
 * What a tile previews: the active version, else the newest version of a template that has none
 * (the detail page's "Latest draft"). Archived templates and ones without versions preview nothing.
 */
export function useTemplateStill(template: TemplateSummaryDto) {
  const { orgId } = useOrgScope();
  const inScope =
    Boolean(orgId) &&
    (template.orgId === null || template.orgId === orgId) &&
    template.status === 'active';
  const unreleased = inScope && !template.activeVersion;
  const detail = useTemplate(unreleased ? template.id : undefined, orgId);
  const draft = unreleased
    ? detail.data?.versions.reduce<{ version: string; createdAt: number } | undefined>(
        (latest, v) => (!latest || v.createdAt > latest.createdAt ? v : latest),
        undefined,
      )
    : undefined;
  const live = inScope && Boolean(template.activeVersion);
  const preview = useTemplatePreview(live || draft ? template.id : '', orgId, draft?.version);
  return {
    draft: Boolean(draft),
    preview: live || draft ? preview.data : undefined,
    pending: (unreleased && detail.isPending) || ((live || Boolean(draft)) && preview.isPending),
  };
}

/** The template's sample pass as a still; archived templates and ones without versions show an empty slot. */
export function TemplateStill({
  template,
  deal,
  className,
}: {
  template: TemplateSummaryDto;
  deal?: boolean;
  className?: string;
}) {
  const { preview, pending } = useTemplateStill(template);
  return (
    // Decorative: inert keeps the pass's own links out of the tab order and the a11y tree.
    <div inert aria-hidden className={cn('pointer-events-none', className)}>
      {preview ? (
        <PassPreview
          passJson={preview.passJson}
          assetBaseUrl={preview.assetBaseUrl}
          assetNames={preview.assetNames}
          still
          enter={deal}
        />
      ) : pending ? (
        <Skeleton className="mx-auto aspect-[320/420] w-full max-w-xs rounded-xl" />
      ) : (
        <div className="mx-auto aspect-[320/420] w-full max-w-xs rounded-xl border border-dashed border-border-strong" />
      )}
    </div>
  );
}

/** The org's mark as a scope: the user tile for a personal org, else its avatar. */
export function TemplateOrgMark({ template }: { template: TemplateSummaryDto }) {
  const { memberships } = useOrgScope();
  const member = memberships.find((m) => m.orgId === template.orgId);
  if (member) return <OrgMark org={member} />;
  return (
    <EntityAvatar
      kind="org"
      id={template.orgId ?? ''}
      name={template.orgName ?? template.name}
      size={24}
    />
  );
}

/** The badge a tile carries: Draft before a first release, else Archived or Built-in. */
function TileBadge({ template }: { template: TemplateSummaryDto }) {
  const { draft } = useTemplateStill(template);
  if (draft) return <Badge>Draft</Badge>;
  // Built-in names a template that ships with PassBook; an uploaded one needs no badge.
  if (template.status === 'archived' || template.origin === 'baked')
    return (
      <Badge>{template.status === 'archived' ? 'Archived' : originLabel(template.origin)}</Badge>
    );
  return null;
}

export const GALLERY_GRID = 'grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3 2xl:grid-cols-4';
export const GALLERY_CARD =
  'relative flex min-w-0 flex-col overflow-hidden rounded-lg border border-border bg-surface-raised shadow-elevation-1';

/** The gallery's card shell and grid, so the page does not jump when the cards arrive. */
export function TemplateGallerySkeleton({ cards = 8 }: { cards?: number }) {
  return (
    <div role="status" aria-busy className={GALLERY_GRID}>
      <span className="sr-only">Loading templates</span>
      {Array.from({ length: cards }, (_, i) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: placeholders have no identity
        <div key={i} className={GALLERY_CARD}>
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
    <ul aria-label="Templates" className={cn('wl-dim', GALLERY_GRID)}>
      {items.map((t, i) => (
        <li
          key={t.id}
          style={{ '--i': i } as CSSProperties}
          className={cn(
            GALLERY_CARD,
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
              arrival === 'rise' && 'wl-rise [--wl-delay:calc(min(var(--i),6)*60ms+160ms)]',
            )}
          >
            {t.orgId ? (
              <TemplateOrgMark template={t} />
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
                {displayName(t)}
              </Link>
              <p className="truncate text-xs text-fg-muted">
                {t.passCount} {t.passCount === 1 ? 'pass' : 'passes'}
              </p>
            </div>
            <TileBadge template={t} />
          </div>
        </li>
      ))}
    </ul>
  );
}
