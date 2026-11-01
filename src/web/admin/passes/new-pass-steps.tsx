import type { CSSProperties } from 'react';
import { cn } from '../../lib/cn.ts';
import { useArrival } from '../../lib/motion.ts';
import { useOrgOptions } from '../../lib/search.ts';
import { EmptyState, ErrorState, Spinner } from '../../ui/index.ts';
import { useTemplatePreview, useTemplates } from '../templates/api.ts';
import { PassPreview } from './pass-preview.tsx';

export function OrgStep({
  orgId,
  onSelect,
}: {
  orgId: string | undefined;
  onSelect: (id: string) => void;
}) {
  const orgs = useOrgOptions();
  if (orgs.isPending) return <Spinner />;
  if (orgs.isError) return <ErrorState error={orgs.error} onRetry={() => void orgs.refetch()} />;
  const items = orgs.data.items.filter((o) => o.status === 'active');
  if (items.length === 0) return <EmptyState art="building" title="No active organizations" />;
  return (
    <ul className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
      {items.map((o) => (
        <li key={o.id}>
          <button
            type="button"
            aria-pressed={o.id === orgId}
            onClick={() => onSelect(o.id)}
            className={cn(
              'w-full rounded-lg border bg-surface-raised p-4 text-left transition-colors hover:bg-state-hover-tint',
              'focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus',
              o.id === orgId ? 'border-accent' : 'border-border',
            )}
          >
            <span className="block font-medium text-fg-strong">{o.name}</span>
            <span className="block text-xs text-fg-muted">{o.slug}</span>
          </button>
        </li>
      ))}
    </ul>
  );
}

function TemplateCard({
  id,
  name,
  description,
  selected,
  onSelect,
}: {
  id: string;
  name: string;
  description: string | null;
  selected: boolean;
  onSelect: () => void;
}) {
  const preview = useTemplatePreview(id);
  return (
    <button
      type="button"
      aria-pressed={selected}
      onClick={onSelect}
      className={cn(
        'flex h-full w-full flex-col gap-3 rounded-lg border bg-surface-raised p-4 text-left transition-colors hover:bg-state-hover-tint',
        'focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus',
        selected ? 'border-accent' : 'border-border',
      )}
    >
      <div
        className="pointer-events-none max-h-56 overflow-hidden [mask-image:linear-gradient(to_bottom,black_65%,transparent)]"
        inert
      >
        {preview.data ? (
          <PassPreview
            passJson={preview.data.passJson}
            assetBaseUrl={preview.data.assetBaseUrl}
            assetNames={preview.data.assetNames}
            still
            className="max-w-48"
          />
        ) : preview.isPending ? (
          <Spinner />
        ) : (
          <p className="text-xs text-fg-muted">No preview</p>
        )}
      </div>
      <span>
        <span className="block font-medium text-fg-strong">{name}</span>
        {description ? <span className="block text-xs text-fg-muted">{description}</span> : null}
      </span>
    </button>
  );
}

export function TemplateStep({
  orgId,
  templateId,
  onSelect,
}: {
  orgId: string;
  templateId: string | undefined;
  onSelect: (id: string) => void;
}) {
  const templates = useTemplates({ orgId });
  const arrived = useArrival(templates.isPending);
  if (templates.isPending) return <Spinner />;
  if (templates.isError) {
    return <ErrorState error={templates.error} onRetry={() => void templates.refetch()} />;
  }
  const items = templates.data.items.filter((t) => t.status === 'active' && t.activeVersion);
  if (items.length === 0)
    return <EmptyState art="template" title="No templates for this organization" />;
  const own = items.filter((t) => t.orgId === orgId);
  const rest = items.filter((t) => t.orgId !== orgId);
  const grid = (list: typeof items) => (
    <ul className={cn('grid gap-3 sm:grid-cols-2 lg:grid-cols-3', arrived && 'wl-deal')}>
      {list.map((t, i) => (
        <li key={t.id} style={{ '--i': i } as CSSProperties}>
          <TemplateCard
            id={t.id}
            name={t.name}
            description={t.description}
            selected={t.id === templateId}
            onSelect={() => onSelect(t.id)}
          />
        </li>
      ))}
    </ul>
  );
  if (own.length === 0) return grid(rest);
  return (
    <div className="grid gap-6">
      <section aria-labelledby="templates-own" className="grid gap-3">
        <h3 id="templates-own" className="text-sm font-medium text-fg-strong">
          {own[0]?.orgName ?? 'Organization'}
        </h3>
        {grid(own)}
      </section>
      {rest.length > 0 ? (
        <section aria-labelledby="templates-other" className="grid gap-3">
          <h3 id="templates-other" className="text-sm font-medium text-fg-strong">
            Other templates
          </h3>
          {grid(rest)}
        </section>
      ) : null}
    </div>
  );
}
