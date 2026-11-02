import { type CSSProperties, type ReactNode, useId } from 'react';
import type { TemplateSummaryDto } from '@/shared/contracts/templates.ts';
import { cn } from '../../lib/cn.ts';
import { useMediaQuery } from '../../lib/media.ts';
import { useArrival } from '../../lib/motion.ts';
import {
  CheckboxField,
  EmptyState,
  EntityAvatar,
  ErrorState,
  FormField,
  Input,
  OptionTile,
  Skeleton,
  SkeletonRows,
  SkeletonTileGrid,
} from '../../ui/index.ts';
import { useTemplatePreview } from '../templates/api.ts';
import { PassPreview } from './pass-preview.tsx';
import { groupTemplates } from './template-groups.ts';

export interface OrgOption {
  id: string;
  name: string;
  slug: string;
  branding: { accent?: string | undefined };
}

/** Tiles lay out on their own width: a column drops before a name truncates. */
const TILE_GRID = 'grid grid-cols-[repeat(auto-fill,minmax(min(100%,18rem),1fr))] gap-3';

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
        className={className ?? TILE_GRID}
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
    <div aria-hidden inert className="pointer-events-none w-10 shrink-0">
      {preview.data ? (
        <PassPreview
          passJson={preview.data.passJson}
          assetBaseUrl={preview.data.assetBaseUrl}
          assetNames={preview.data.assetNames}
          still
        />
      ) : (
        <Skeleton className="aspect-[320/420] w-full rounded-sm" />
      )}
    </div>
  );
}

/**
 * Template tiles grouped by scope: the org's own, then Shared. From 1024 the stage shows the
 * chosen template's description, so a tile is a still and a name.
 */
export function TemplateStep({
  templates,
  orgName,
  loading,
  error,
  templateId,
  onSelect,
  onCommit,
  choiceError,
}: {
  templates: TemplateSummaryDto[];
  /** Names the org's group when a summary lacks it. */
  orgName?: string | undefined;
  loading: boolean;
  error: unknown;
  templateId: string | undefined;
  onSelect: (id: string) => void;
  onCommit: (id: string) => void;
  /** Next was pressed with nothing chosen. */
  choiceError?: string | undefined;
}) {
  const arrived = useArrival(loading);
  const staged = useMediaQuery('(min-width: 1024px)');
  if (loading) return <SkeletonTileGrid label="Loading templates" />;
  if (error) return <ErrorState error={error} />;
  if (templates.length === 0)
    return <EmptyState art="template" title="No templates for this organization" />;
  let i = 0;
  return (
    <ChoiceGroup label="Template" error={choiceError} className="flex flex-col gap-6">
      {groupTemplates(templates, orgName).map((g) => (
        <fieldset key={g.key} className="min-w-0">
          <legend className="mb-3 text-xs font-medium text-fg-muted">{g.label}</legend>
          <div className={cn(TILE_GRID, arrived && 'wl-stagger')}>
            {g.items.map(({ template: t, name }) => (
              <div key={t.id} style={{ '--i': i++ } as CSSProperties}>
                <OptionTile
                  name="template"
                  value={t.id}
                  checked={t.id === templateId}
                  onSelect={onSelect}
                  onCommit={onCommit}
                  media={<TemplateStill id={t.id} />}
                  label={name}
                  description={staged ? undefined : (t.description ?? undefined)}
                  className="h-full items-center p-3"
                />
              </div>
            ))}
          </div>
        </fieldset>
      ))}
    </ChoiceGroup>
  );
}

/** Holder: an optional email, and whether to send the pass there now. */
export function HolderStep({
  email,
  onEmail,
  error,
  valid,
  send,
  onSend,
}: {
  email: string;
  onEmail: (email: string) => void;
  error: string | undefined;
  valid: boolean;
  send: boolean;
  onSend: (send: boolean) => void;
}) {
  return (
    <div className="flex flex-col gap-4">
      <FormField label="Holder email" help="Leave empty to add a holder later." error={error}>
        {(c) => (
          <Input
            {...c}
            type="email"
            autoComplete="off"
            value={email}
            onChange={(e) => onEmail(e.target.value)}
          />
        )}
      </FormField>
      <CheckboxField
        label={valid ? `Email the pass to ${email.trim()}` : 'Email the pass'}
        checked={send && valid}
        disabled={!valid}
        onCheckedChange={(c) => onSend(c === true)}
      />
    </div>
  );
}
