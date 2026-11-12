import type { UseQueryResult } from '@tanstack/react-query';
import { useQueries } from '@tanstack/react-query';
import { useMemo } from 'react';
import type { BroadcastPreviewDto } from '@/shared/contracts/broadcasts.ts';
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
import { useScanEvents } from '../scanning/scanner-api.ts';
import { templateDetailQuery } from '../templates/api.ts';
import type { ComposerState, HolderChoice } from './composer-state.ts';
import { HOLDER_LABEL } from './labels.ts';

const HOLDERS: readonly { value: HolderChoice; label: string }[] = [
  { value: 'any', label: 'Any holder' },
  ...(Object.entries(HOLDER_LABEL) as [Exclude<HolderChoice, 'any'>, string][]).map(
    ([value, label]) => ({ value, label }),
  ),
];

/** Details of the templates the picker offers; a message needs the manifest's messaging key. */
export function useTemplateDetails(templates: readonly TemplateSummaryDto[], orgId: string) {
  const results = useQueries({ queries: templates.map((t) => templateDetailQuery(t.id, orgId)) });
  return useMemo(
    () =>
      new Map(
        results.flatMap((r) =>
          r.data && (r.data.orgId === null || r.data.orgId === orgId)
            ? [[r.data.id, r.data] as const]
            : [],
        ),
      ),
    [orgId, results],
  );
}

export function AudienceSection({
  orgId,
  state,
  onChange,
  templates,
  loading,
  details,
  count,
  error,
  scanError,
}: {
  orgId: string | undefined;
  state: ComposerState;
  onChange: (patch: Partial<ComposerState>) => void;
  templates: readonly TemplateSummaryDto[];
  loading: boolean;
  details: ReturnType<typeof useTemplateDetails>;
  /** The composer's one (debounced) count, the same the send confirm waits on. */
  count: Pick<UseQueryResult<BroadcastPreviewDto>, 'data' | 'isPlaceholderData'>;
  error?: string | undefined;
  scanError?: string | undefined;
}) {
  const eventFilter = state.scanKind === 'checkedIn' || state.scanKind === 'notCheckedIn';
  const events = useScanEvents(orgId, Boolean(orgId) && eventFilter);
  const toggle = (id: string, on: boolean) =>
    onChange({
      templateIds: on ? [...state.templateIds, id] : state.templateIds.filter((x) => x !== id),
    });
  const c = count.isPlaceholderData ? undefined : count.data;
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
            // A template whose details have not loaded cannot be told apart yet.
            const unknown = state.kind === 'message' && detail === undefined;
            return (
              <div key={t.id} className="flex flex-wrap items-center gap-x-3">
                <CheckboxField
                  label={t.name}
                  checked={state.templateIds.includes(t.id)}
                  disabled={noMessage || (unknown && !state.templateIds.includes(t.id))}
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
        help="Only passes with a device registration are included."
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
      <FormField label="Scan activity">
        {(control) => (
          <Select
            {...control}
            value={state.scanKind}
            options={[
              { value: 'any', label: 'Any scan activity' },
              { value: 'checkedIn', label: 'Checked in to an event' },
              { value: 'notCheckedIn', label: 'Not checked in to an event' },
              { value: 'noScan30', label: 'No completed scan in 30 days' },
              { value: 'noScan90', label: 'No completed scan in 90 days' },
            ]}
            onValueChange={(scanKind) =>
              onChange({ scanKind: scanKind as ComposerState['scanKind'] })
            }
          />
        )}
      </FormField>
      {eventFilter ? (
        <FormField label="Scan event" error={scanError}>
          {(control) => (
            <Select
              {...control}
              value={state.scanEventId || undefined}
              placeholder={events.isError ? 'Could not load events' : 'Choose an event'}
              options={[
                ...(events.data?.items ?? []).map((event) => ({
                  value: event.id,
                  label: event.name,
                })),
                ...(state.scanEventId &&
                !events.data?.items.some((event) => event.id === state.scanEventId)
                  ? [{ value: state.scanEventId, label: state.scanEventId }]
                  : []),
              ]}
              onValueChange={(scanEventId) => onChange({ scanEventId })}
            />
          )}
        </FormField>
      ) : null}
      <p aria-live="polite" className="text-sm text-fg-muted">
        {!c
          ? state.templateIds.length === 0
            ? 'Choose a template to see who is reached.'
            : eventFilter && !state.scanEventId
              ? 'Choose an event to count the audience.'
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
