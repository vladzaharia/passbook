import { useEffect } from 'react';
import type { Mode } from '@/shared/contracts/common.ts';
import { useMode } from '@/web/lib/mode.ts';
import { useOrgScope } from '@/web/lib/org-filter.tsx';
import { Button, CheckboxField, ErrorState } from '@/web/ui/index.ts';
import { useEligibleTemplates, useOrgTemplates } from './scanner-api.ts';

/**
 * The one place scanning admin picks templates: approved releases for an organization and mode,
 * by name. A selection that is no longer eligible keeps its name and can be removed, not re-added.
 */
export function EligibleTemplatePicker({
  orgId,
  selected,
  onChange,
  mode,
  enabled = true,
  requireCheckIn = false,
  error,
  errorId,
}: {
  orgId: string;
  selected: string[];
  onChange: (ids: string[]) => void;
  /** The mode the templates are for, when it can differ from the console's. */
  mode?: Mode;
  enabled?: boolean;
  /** Events need a check-in action: a template without one cannot be added. */
  requireCheckIn?: boolean;
  error?: string | undefined;
  errorId?: string;
}) {
  const scope = useOrgScope();
  const currentMode = useMode();
  const templates = useEligibleTemplates(orgId || undefined, enabled, mode);
  const available =
    templates.isFetchedAfterMount &&
    !templates.isError &&
    (!templates.isFetching || templates.isFetchingNextPage);
  const items = available ? (templates.data?.pages.flatMap((page) => page.items) ?? []) : [];
  const missing = selected.filter((id) => !items.some((item) => item.templateId === id));
  const { hasNextPage, isFetchingNextPage, fetchNextPage } = templates;
  // A selection on a page that is not loaded yet is not "ineligible": load pages until it shows up.
  const searching = available && missing.length > 0 && hasNextPage;
  useEffect(() => {
    if (searching && !isFetchingNextPage) void fetchNextPage();
  }, [searching, isFetchingNextPage, fetchNextPage]);
  const names = useOrgTemplates(available && missing.length > 0 ? orgId : undefined);
  const nameOf = (id: string) => names.data?.items.find((t) => t.id === id)?.name ?? 'Template';
  const canRead = Boolean(
    scope.membership?.capabilities.includes('templates:read') ||
      scope.membership?.capabilities.includes('passes:read'),
  );
  const set = (id: string, on: boolean) =>
    onChange(on ? [...selected, id] : selected.filter((value) => value !== id));
  const empty = scope.isLoading
    ? 'Loading…'
    : scope.isError
      ? 'Could not load organization access.'
      : !scope.orgId || scope.orgId !== orgId
        ? 'Choose an organization first.'
        : mode && currentMode !== mode
          ? `Switch to ${mode === 'test' ? 'Test' : 'Live'} mode to choose templates.`
          : !canRead
            ? 'You do not have permission to view eligible templates.'
            : !templates.isFetchedAfterMount
              ? 'Checking approved releases…'
              : 'No approved templates available.';
  return (
    <fieldset
      className="flex min-w-0 flex-col gap-2"
      aria-describedby={error ? errorId : undefined}
    >
      <legend className="mb-2 text-sm font-medium text-fg">Templates</legend>
      {items.map((item, i) => {
        const checked = selected.includes(item.templateId);
        const noCheckIn = requireCheckIn && !item.supportsCheckIn;
        return (
          <CheckboxField
            key={item.templateId}
            checked={checked}
            aria-invalid={error && i === 0 ? true : undefined}
            disabled={noCheckIn && !checked}
            label={
              <>
                {item.name}
                {noCheckIn ? (
                  <span className="ml-2 text-xs text-fg-muted">No check-in action</span>
                ) : null}
              </>
            }
            onCheckedChange={(on) => {
              if (on && noCheckIn) return;
              set(item.templateId, on === true);
            }}
          />
        );
      })}
      {missing.map((id) => (
        <CheckboxField
          key={`selected-${id}`}
          checked
          label={`${nameOf(id)} · ${templates.isFetching || searching ? 'checking release' : 'no approved release'}`}
          onCheckedChange={(on) => {
            if (!on) set(id, false);
          }}
        />
      ))}
      {templates.isError ? (
        <ErrorState
          inline
          subject="eligible templates"
          error={templates.error}
          onRetry={() => templates.refetch()}
        />
      ) : !items.length && !templates.isFetching ? (
        <p className="text-sm text-fg-muted">{empty}</p>
      ) : !items.length ? (
        <p className="text-sm text-fg-muted">Loading…</p>
      ) : null}
      {templates.hasNextPage ? (
        <Button
          type="button"
          variant="ghost"
          disabled={!available}
          loading={templates.isFetchingNextPage}
          onClick={() => void templates.fetchNextPage()}
        >
          Load more templates
        </Button>
      ) : null}
      {error ? (
        <p id={errorId} className="mt-1 text-xs text-danger">
          {error}
        </p>
      ) : null}
    </fieldset>
  );
}
