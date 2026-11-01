import type { CSSProperties } from 'react';
import type { TemplateSummaryDto } from '@/shared/contracts/templates.ts';
import { cn } from '../../lib/cn.ts';
import { useArrival } from '../../lib/motion.ts';
import {
  Badge,
  EmptyState,
  EntityAvatar,
  ErrorState,
  OptionTile,
  Skeleton,
  SkeletonRows,
  SkeletonTileGrid,
} from '../../ui/index.ts';
import { useTemplatePreview } from '../templates/api.ts';
import { PassPreview } from './pass-preview.tsx';

export interface OrgOption {
  id: string;
  name: string;
  slug: string;
  branding: { accent?: string | undefined };
}

export function OrgStep({
  orgs,
  loading,
  error,
  orgId,
  onSelect,
  onCommit,
}: {
  orgs: OrgOption[];
  loading: boolean;
  error: unknown;
  orgId: string | undefined;
  onSelect: (id: string) => void;
  onCommit: (id: string) => void;
}) {
  if (loading) return <SkeletonRows rows={3} label="Loading organizations" />;
  if (error) return <ErrorState error={error} />;
  if (orgs.length === 0) return <EmptyState art="building" title="No active organizations" />;
  return (
    <div
      role="radiogroup"
      aria-label="Organization"
      className="grid gap-3 @container sm:grid-cols-2 xl:grid-cols-3"
    >
      {orgs.map((o) => (
        <OptionTile
          key={o.id}
          name="org"
          value={o.id}
          checked={o.id === orgId}
          onSelect={onSelect}
          onCommit={onCommit}
          media={
            <EntityAvatar kind="org" id={o.id} name={o.name} accent={o.branding.accent} size={40} />
          }
          label={o.name}
          description={o.slug}
        />
      ))}
    </div>
  );
}

function TemplateStill({ id }: { id: string }) {
  const preview = useTemplatePreview(id);
  return (
    <div aria-hidden inert className="pointer-events-none w-14 shrink-0">
      {preview.data ? (
        <PassPreview
          passJson={preview.data.passJson}
          assetBaseUrl={preview.data.assetBaseUrl}
          assetNames={preview.data.assetNames}
          still
        />
      ) : (
        <Skeleton className="aspect-[320/420] w-full rounded-md" />
      )}
    </div>
  );
}

/** Template choices as tiles with a still; Shared marks platform templates every org can use. */
export function TemplateStep({
  templates,
  loading,
  error,
  templateId,
  onSelect,
  onCommit,
}: {
  templates: TemplateSummaryDto[];
  loading: boolean;
  error: unknown;
  templateId: string | undefined;
  onSelect: (id: string) => void;
  onCommit: (id: string) => void;
}) {
  const arrived = useArrival(loading);
  if (loading) return <SkeletonTileGrid label="Loading templates" />;
  if (error) return <ErrorState error={error} />;
  if (templates.length === 0)
    return <EmptyState art="template" title="No templates for this organization" />;
  return (
    <div
      role="radiogroup"
      aria-label="Template"
      className={cn('grid gap-3 sm:grid-cols-2 xl:grid-cols-3', arrived && 'wl-stagger')}
    >
      {templates.map((t, i) => (
        <div key={t.id} style={{ '--i': i } as CSSProperties}>
          <OptionTile
            name="template"
            value={t.id}
            checked={t.id === templateId}
            onSelect={onSelect}
            onCommit={onCommit}
            media={<TemplateStill id={t.id} />}
            label={
              <span className="inline-flex min-w-0 items-center gap-2">
                <span className="truncate">{t.name}</span>
                {t.orgId === null ? <Badge>Shared</Badge> : null}
              </span>
            }
            description={t.description ?? undefined}
            className="h-full"
          />
        </div>
      ))}
    </div>
  );
}
