import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { useDebounced } from '@/web/lib/debounce.ts';
import { ENTITY } from '@/web/lib/entities.ts';
import { errorMessage, isApiError } from '@/web/lib/errors.ts';
import { Button, Combobox, type ComboboxOption } from '@/web/ui/index.ts';
import { useDesignerHost, useHostKey } from '../host.tsx';

const MIN_QUERY = 2;
const PassIcon = ENTITY.pass.icon;
const icon = <PassIcon aria-hidden className="size-4 shrink-0 text-fg-muted" />;

/** One sentence for why a real pass cannot be previewed. */
export function previewErrorMessage(error: unknown): string {
  if (isApiError(error)) {
    if (error.status === 404) return 'That pass is not in this template and mode. Pick another.';
    if (error.status === 403) return 'You cannot preview passes in this organization.';
  }
  return errorMessage(error);
}

/** Passes of the host's organization, in its mode, through its client. */
function usePassOptions(term: string): { options: ComboboxOption[]; loading: boolean } {
  const { searchPasses, orgId, mode } = useDesignerHost();
  const hostKey = useHostKey();
  const query = useQuery({
    queryKey: ['designer', 'pass-search', orgId ?? null, mode, term, ...hostKey],
    queryFn: ({ signal }) => searchPasses(term, signal),
    enabled: Boolean(orgId) && term.length >= MIN_QUERY,
    staleTime: 15_000,
  });
  return {
    options: (query.data ?? []).map((p) => ({ value: p.id, label: p.title ?? p.serial, icon })),
    loading: query.isFetching,
  };
}

export function RealPassPicker({
  passId,
  error,
  onPick,
  onRetry,
}: {
  passId: string | null;
  error: unknown;
  onPick: (id: string) => void;
  onRetry: () => void;
}) {
  const [typed, setTyped] = useState('');
  const found = usePassOptions(useDebounced(typed.trim(), 200));
  const options =
    passId && !found.options.some((o) => o.value === passId)
      ? [{ value: passId, label: 'Selected pass', icon }, ...found.options]
      : found.options;
  return (
    <>
      <div className="sp-pass-id">
        <Combobox
          aria-label="Pass"
          options={options}
          value={passId ?? undefined}
          onValueChange={onPick}
          onSearch={setTyped}
          loading={found.loading}
          placeholder="Find a pass"
          searchPlaceholder="Search passes"
        />
      </div>
      {error ? (
        <p className="sp-error" role="alert">
          {previewErrorMessage(error)}{' '}
          <Button size="sm" variant="outline" onClick={onRetry}>
            Retry
          </Button>
        </p>
      ) : null}
    </>
  );
}
