import { Clock } from 'lucide-react';
import type { ScanSetupCheck } from '@/shared/contracts/scan-setup-intent.ts';
import { hasErrors } from '@/shared/scan-setup-checks.ts';
import { zoneLabel, zoneOptions } from '@/web/lib/timezones.ts';
import { ErrorState, FormField, Select, Skeleton } from '@/web/ui/index.ts';
import { CheckList } from './check-list.tsx';
import { DoorSummary } from './door-summary.tsx';
import type { StepId } from './draft.ts';
import { type SummaryLine, settingsLine } from './summary.ts';
import type { SetupPreview } from './types.ts';

const ZONES = zoneOptions().map((z) => ({ value: z.value, label: z.label }));

/** Review: the plan's checks with one-tap fixes, the door summary with Edit, the time zone once. */
export function ReviewStep({
  name,
  lines,
  preview,
  timeZone,
  onZone,
  onEdit,
  onFix,
  namesFor,
}: {
  name: string;
  lines: readonly SummaryLine[];
  preview: {
    data: SetupPreview | undefined;
    error: unknown;
    isPending: boolean;
    refetch: () => unknown;
  };
  timeZone: string;
  onZone: (zone: string) => void;
  onEdit: (step: StepId) => void;
  onFix: (c: ScanSetupCheck) => void;
  namesFor: (c: ScanSetupCheck) => { device?: string; person?: string };
}) {
  const checks = preview.data?.plan.checks ?? [];
  const settings = settingsLine(preview.data?.plan.sessions[0]);
  return (
    <div className="grid gap-6">
      <DoorSummary name={name} lines={lines} onEdit={onEdit} scene="peek" />
      {settings ? (
        <p data-testid="settings-line" className="-mt-3 px-1 text-sm text-fg-muted">
          {settings}
        </p>
      ) : null}
      <section
        aria-label="Checks"
        className="grid gap-3 rounded-lg border border-border bg-surface-raised p-4"
      >
        <h3 className="flex items-center gap-2 text-sm font-semibold text-fg-strong">
          Checks
          {checks.length > 0 ? (
            <span className="rounded-full bg-surface-sunken px-2 text-xs tabular-nums text-fg-muted">
              {checks.length}
            </span>
          ) : null}
        </h3>
        {preview.error ? (
          <ErrorState
            inline
            error={preview.error}
            subject="the plan"
            onRetry={() => preview.refetch()}
          />
        ) : preview.isPending ? (
          <Skeleton className="h-10" />
        ) : (
          <CheckList checks={checks} namesFor={namesFor} onFix={onFix} />
        )}
        {hasErrors(checks) ? (
          <p role="status" className="text-xs text-danger">
            Fix {checks.filter((c) => c.level === 'error').length} error to set up.
          </p>
        ) : null}
      </section>
      <section
        aria-label="Time zone"
        className="flex items-start gap-3 rounded-lg border border-border bg-surface-raised p-4"
      >
        <Clock aria-hidden className="mt-9 size-4 shrink-0 text-fg-muted" />
        <FormField label="Time zone" className="min-w-0 max-w-sm flex-1">
          {(c) => (
            <Select
              {...c}
              options={
                ZONES.some((z) => z.value === timeZone)
                  ? ZONES
                  : [{ value: timeZone, label: zoneLabel(timeZone) }, ...ZONES]
              }
              value={timeZone}
              onValueChange={onZone}
            />
          )}
        </FormField>
      </section>
    </div>
  );
}
