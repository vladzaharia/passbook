import { useQueries } from '@tanstack/react-query';
import { useMemo } from 'react';
import type { TemplateSummaryDto } from '@/shared/contracts/templates.ts';
import { formatCount } from '../../lib/format.ts';
import {
  Callout,
  CheckboxField,
  FormField,
  Input,
  Select,
  Skeleton,
  SwitchRow,
} from '../../ui/index.ts';
import { templateDetailQuery } from '../templates/api.ts';
import { useAudienceCount } from './api.ts';
import { type ComposerState, type HolderChoice, targetOf } from './composer-state.ts';

const HOLDERS: readonly { value: HolderChoice; label: string }[] = [
  { value: 'any', label: 'Any holder' },
  { value: 'owned', label: 'Claimed' },
  { value: 'waiting', label: 'Not claimed' },
  { value: 'unassigned', label: 'No holder' },
];

/** Details of the templates the picker offers; a message needs the manifest's messaging key. */
export function useTemplateDetails(templates: readonly TemplateSummaryDto[]) {
  const results = useQueries({
    queries: templates.slice(0, 30).map((t) => templateDetailQuery(t.id)),
  });
  return useMemo(
    () => new Map(results.flatMap((r) => (r.data ? [[r.data.id, r.data] as const] : []))),
    [results],
  );
}

export function AudienceSection({
  orgId,
  state,
  onChange,
  templates,
  loading,
  details,
  error,
}: {
  orgId: string | undefined;
  state: ComposerState;
  onChange: (patch: Partial<ComposerState>) => void;
  templates: readonly TemplateSummaryDto[];
  loading: boolean;
  details: ReturnType<typeof useTemplateDetails>;
  error?: string | undefined;
}) {
  const count = useAudienceCount(orgId, targetOf(state));
  const toggle = (id: string, on: boolean) =>
    onChange({
      templateIds: on ? [...state.templateIds, id] : state.templateIds.filter((x) => x !== id),
    });
  const c = count.data;
  return (
    <div className="flex flex-col gap-4">
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
              state.kind === 'message' &&
              detail !== undefined &&
              !(detail.manifest as { messaging?: unknown } | null)?.messaging;
            return (
              <div key={t.id} className="flex flex-wrap items-center gap-x-3">
                <CheckboxField
                  label={t.name}
                  checked={state.templateIds.includes(t.id)}
                  disabled={noMessage}
                  onCheckedChange={(on) => toggle(t.id, on === true)}
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
      <SwitchRow
        label="On a device only"
        help="Skip passes nobody has added to Wallet."
        checked={state.onDevice}
        onCheckedChange={(onDevice) => onChange({ onDevice })}
      />
      <div className="grid gap-4 sm:grid-cols-2">
        <FormField label="Holder">
          {(control) => (
            <Select
              {...control}
              options={HOLDERS}
              value={state.holder}
              onValueChange={(holder) => onChange({ holder: holder as HolderChoice })}
            />
          )}
        </FormField>
        <FormField label="Search">
          {(control) => (
            <Input
              {...control}
              value={state.q}
              placeholder="Name, ID or email"
              maxLength={200}
              onChange={(e) => onChange({ q: e.target.value })}
            />
          )}
        </FormField>
      </div>
      <p aria-live="polite" className="text-sm text-fg-muted">
        {!c
          ? state.templateIds.length === 0
            ? 'Choose a template to see who is reached.'
            : 'Counting…'
          : `${formatCount(c.targeted)} ${c.targeted === 1 ? 'pass' : 'passes'}, ${formatCount(c.onDevice)} on a device.`}
      </p>
      {c && c.overBudget > 0 ? (
        <Callout tone="warning">
          {formatCount(c.overBudget)} {c.overBudget === 1 ? 'pass is' : 'passes are'} at the limit
          of {c.limit} notifications a day. {c.overBudget === 1 ? 'It updates' : 'They update'}{' '}
          without a notification.
        </Callout>
      ) : null}
    </div>
  );
}
