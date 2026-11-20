import type { TemplateSummaryDto } from '@/shared/contracts/templates.ts';
import { CheckboxField, Skeleton } from '../../ui/index.ts';

/** The templates a message reaches. With `needsMessage`, one with no message field is off. */
export function TemplateChoices({
  orgId,
  templates,
  loading,
  details,
  chosen,
  needsMessage,
  onToggle,
  error,
}: {
  orgId: string | undefined;
  templates: readonly TemplateSummaryDto[];
  loading: boolean;
  details: ReadonlyMap<string, { manifest: unknown }>;
  chosen: readonly string[];
  needsMessage: boolean;
  onToggle: (id: string, on: boolean) => void;
  error?: string | undefined;
}) {
  return (
    <fieldset
      className="flex min-w-0 flex-col gap-1"
      aria-describedby={error ? 'tpl-error' : undefined}
    >
      <legend className="mb-2 text-sm font-medium text-fg-strong">Templates</legend>
      {!orgId ? (
        <p className="text-sm text-fg-muted">Choose an organization first.</p>
      ) : loading ? (
        <Skeleton className="h-10 w-full" />
      ) : templates.length === 0 ? (
        <p className="text-sm text-fg-muted">No templates yet.</p>
      ) : (
        templates.map((t) => {
          const detail = details.get(t.id);
          const noMessage =
            needsMessage &&
            detail !== undefined &&
            !(detail.manifest as { messaging?: unknown } | null)?.messaging;
          // A template whose details have not loaded cannot be told apart yet.
          const unknown = needsMessage && detail === undefined;
          return (
            <div key={t.id} className="flex flex-wrap items-center gap-x-3">
              <CheckboxField
                label={t.name}
                checked={chosen.includes(t.id)}
                disabled={noMessage || (unknown && !chosen.includes(t.id))}
                onCheckedChange={(on) => onToggle(t.id, on === true)}
              />
              {noMessage ? <span className="text-xs text-fg-muted">No message field</span> : null}
            </div>
          );
        })
      )}
      {error ? (
        <p id="tpl-error" className="mt-1 text-xs text-danger">
          {error}
        </p>
      ) : null}
    </fieldset>
  );
}
