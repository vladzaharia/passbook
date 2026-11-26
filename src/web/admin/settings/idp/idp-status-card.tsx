import { FlaskConical, RefreshCw, Snowflake } from 'lucide-react';
import { useState } from 'react';
import type { z } from 'zod';
import type { IdpStatusSchema } from '@/shared/contracts/idp-access.ts';
import { BUDGET_LABEL, PROBLEM_LABEL } from '@/shared/copy/idp-platform.ts';
import {
  checkNowConfirm,
  clearBreakerConfirm,
  dryRunConfirm,
  freezeIdpConfirm,
} from '@/web/lib/confirms-idp.ts';
import { formatCount, formatDay } from '@/web/lib/format.ts';
import {
  Button,
  Callout,
  Card,
  CardBody,
  CardHeader,
  ConfirmDialog,
  FormDialog,
  FormField,
  KeyValue,
  ProgressBar,
  RelTime,
  StatusPill,
  TechnicalDetails,
  Textarea,
  toast,
  useFormErrors,
  useNow,
} from '@/web/ui/index.ts';
import { useIdpActions } from './idp-queries.ts';

type Status = z.infer<typeof IdpStatusSchema>;
type Ask = 'check' | 'dry_run' | 'freeze' | 'breaker' | null;
const FORTNIGHT = 14 * 86_400_000;

/** Group reads the day still allows, from the binding's own count. null when it did not say. */
function readsLeft(status: Status): number | null {
  const b = status.budget.snapshot;
  return b ? Math.max(0, b.limit - b.day) : null;
}

const problemText = (code: string): string => {
  const [head = code, detail] = code.split(':');
  const base = PROBLEM_LABEL[head] ?? head.replace(/_/g, ' ');
  return detail ? `${base} (${detail})` : base;
};

/** Mode, key, last push, budgets and the four controls. A started operation hands its id to the page. */
export function IdpStatusCard({
  status,
  busy,
  onStarted,
}: {
  status: Status;
  /** An operation is on screen: the controls wait for it. */
  busy: boolean;
  onStarted: (operationId: string) => void;
}) {
  const now = useNow(30_000);
  const { check, clearBreaker, freeze } = useIdpActions();
  const [ask, setAsk] = useState<Ask>(null);
  const [reason, setReason] = useState('');
  const reasonCheck = useFormErrors(
    reason.trim().length >= 3 ? {} : { reason: 'Say why, in a few words.' },
  );
  const left = readsLeft(status);
  const live = status.mode === 'live';
  const noReads = left === 0;
  const expiring = status.keyExpiresAt !== null && status.keyExpiresAt - now < FORTNIGHT;
  const mode = status.frozen ? 'idp_paused' : status.mode === 'live' ? 'idp_live' : 'idp_dry_run';
  const open = Object.values(status.drift).reduce((a, n) => a + n, 0);
  const run = (dryRun: boolean) => async () => {
    const operation = await check.mutateAsync(dryRun);
    onStarted(operation.id);
  };
  const checkCopy = checkNowConfirm(live, left);
  const dryCopy = dryRunConfirm(left);
  const breakerCopy = clearBreakerConfirm();
  const freezeCopy = freezeIdpConfirm();
  return (
    <Card>
      <CardHeader title="Polaris ID access" actions={<StatusPill status={mode} />} />
      <CardBody className="flex flex-col gap-4">
        {status.breakerOpen ? (
          <Callout
            tone="danger"
            title="SCIM breaker tripped"
            actionsAside
            actions={
              <Button size="sm" variant="outline" disabled={busy} onClick={() => setAsk('breaker')}>
                Clear breaker
              </Button>
            }
          >
            Sessions it held back stay held until you clear it.
          </Callout>
        ) : null}
        {status.problems.length > 0 ? (
          <Callout tone="warning" items={status.problems.map(problemText)} />
        ) : null}
        <KeyValue
          items={[
            {
              label: 'Key expires',
              value: (
                <span className="inline-flex flex-wrap items-center gap-2">
                  {formatDay(status.keyExpiresAt, 'Not set')}
                  {expiring ? <StatusPill status="expiring" tone="warning" /> : null}
                </span>
              ),
            },
            {
              label: 'Last change from Polaris ID',
              value: status.lastScimAt ? <RelTime at={status.lastScimAt} now={now} /> : 'Never',
            },
            { label: 'Differences', value: open === 0 ? 'None' : formatCount(open) },
          ]}
        />
        {left === null ? null : (
          <div className="flex flex-col gap-1.5">
            <ProgressBar
              label="Group reads used today"
              value={status.budget.snapshot?.day ?? 0}
              max={status.budget.snapshot?.limit ?? 1}
              tone={left <= 3 ? 'warning' : 'accent'}
              valueText={`${left} of ${status.budget.snapshot?.limit} group reads left today`}
            />
            <p className="text-xs text-fg-muted">
              {left} of {status.budget.snapshot?.limit} group reads left today.
              {noReads ? ' Check now waits until tomorrow.' : ''}
            </p>
          </div>
        )}
        <div className="flex flex-wrap gap-2">
          <Button
            iconStart={<RefreshCw aria-hidden />}
            disabled={busy || noReads || status.frozen === true}
            onClick={() => setAsk('check')}
          >
            Check now
          </Button>
          {live ? (
            <Button
              variant="outline"
              iconStart={<FlaskConical aria-hidden />}
              disabled={busy || noReads}
              onClick={() => setAsk('dry_run')}
            >
              Dry run
            </Button>
          ) : null}
          {status.frozen ? null : (
            <Button
              variant="outline"
              iconStart={<Snowflake aria-hidden />}
              onClick={() => setAsk('freeze')}
            >
              Pause changes
            </Button>
          )}
        </div>
        <TechnicalDetails
          items={Object.entries(status.budget).map(([bucket, b]) => ({
            label: BUDGET_LABEL[bucket] ?? bucket,
            value: `${b.day} of ${b.limit} today`,
          }))}
        />
      </CardBody>
      <ConfirmDialog
        open={ask === 'check'}
        onOpenChange={(o) => !o && setAsk(null)}
        title={checkCopy.title}
        description={checkCopy.description}
        confirmLabel={checkCopy.confirmLabel}
        onConfirm={run(false)}
      />
      <ConfirmDialog
        open={ask === 'dry_run'}
        onOpenChange={(o) => !o && setAsk(null)}
        title={dryCopy.title}
        description={dryCopy.description}
        confirmLabel={dryCopy.confirmLabel}
        onConfirm={run(true)}
      />
      <ConfirmDialog
        open={ask === 'breaker'}
        onOpenChange={(o) => !o && setAsk(null)}
        title={breakerCopy.title}
        description={breakerCopy.description}
        confirmLabel={breakerCopy.confirmLabel}
        destructive
        onConfirm={async () => onStarted((await clearBreaker.mutateAsync()).id)}
      />
      <FormDialog
        open={ask === 'freeze'}
        onOpenChange={(o) => !o && setAsk(null)}
        title={freezeCopy.title}
        description={freezeCopy.description}
        size="sm"
        dirty={reason.trim() !== ''}
        check={reasonCheck}
        submitLabel="Pause changes"
        submitTone="danger"
        busy={freeze.isPending}
        onClose={() => setReason('')}
        onSubmit={async () => {
          await freeze.mutateAsync(reason.trim());
          toast.success('Polaris ID changes paused');
          setAsk(null);
        }}
      >
        {({ errors }) => (
          <FormField
            label="Reason"
            required
            error={reasonCheck.errors.reason ?? errors.reason}
            help="Recorded in the audit log."
          >
            {(control) => (
              <Textarea
                {...control}
                data-autofocus
                rows={3}
                maxLength={200}
                value={reason}
                onChange={(event) => setReason(event.target.value)}
              />
            )}
          </FormField>
        )}
      </FormDialog>
    </Card>
  );
}
