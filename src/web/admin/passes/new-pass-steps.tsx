import { type CSSProperties, type ReactNode, useId } from 'react';
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

/** Tiles lay out on their own width: a column drops before a name truncates. */
const TILE_GRID = 'grid grid-cols-[repeat(auto-fill,minmax(min(100%,14rem),1fr))] gap-3';

/** A required choice: the group is invalid and says so under the tiles until one is picked. */
function ChoiceGroup({
  label,
  error,
  className,
  children,
}: {
  label: string;
  error?: string | undefined;
  className?: string;
  children: ReactNode;
}) {
  const id = useId();
  return (
    <div className="flex flex-col gap-2">
      <div
        role="radiogroup"
        aria-label={label}
        aria-invalid={error ? true : undefined}
        aria-describedby={error ? id : undefined}
        className={cn(TILE_GRID, className)}
      >
        {children}
      </div>
      {error ? (
        <p id={id} className="text-xs text-danger">
          {error}
        </p>
      ) : null}
    </div>
  );
}

export function OrgStep({
  orgs,
  loading,
  error,
  orgId,
  onSelect,
  onCommit,
  choiceError,
}: {
  orgs: OrgOption[];
  loading: boolean;
  error: unknown;
  orgId: string | undefined;
  onSelect: (id: string) => void;
  onCommit: (id: string) => void;
  /** Next was pressed with nothing chosen. */
  choiceError?: string | undefined;
}) {
  if (loading) return <SkeletonRows rows={3} label="Loading organizations" />;
  if (error) return <ErrorState error={error} />;
  if (orgs.length === 0) return <EmptyState art="building" title="No active organizations" />;
  return (
    <ChoiceGroup label="Organization" error={choiceError}>
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
    </ChoiceGroup>
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
  choiceError,
}: {
  templates: TemplateSummaryDto[];
  loading: boolean;
  error: unknown;
  templateId: string | undefined;
  onSelect: (id: string) => void;
  onCommit: (id: string) => void;
  /** Next was pressed with nothing chosen. */
  choiceError?: string | undefined;
}) {
  const arrived = useArrival(loading);
  if (loading) return <SkeletonTileGrid label="Loading templates" />;
  if (error) return <ErrorState error={error} />;
  if (templates.length === 0)
    return <EmptyState art="template" title="No templates for this organization" />;
  return (
    <ChoiceGroup label="Template" error={choiceError} className={cn(arrived && 'wl-stagger')}>
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
    </ChoiceGroup>
  );
}
