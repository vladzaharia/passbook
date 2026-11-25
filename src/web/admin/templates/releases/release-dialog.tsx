import { useState } from 'react';
import type {
  TemplateRelease,
  TemplateReleaseScope,
} from '@/shared/contracts/template-releases.ts';
import { UserMessageError } from '../../../lib/errors.ts';
import {
  Callout,
  ErrorState,
  FormDialog,
  FormField,
  KeyValue,
  Skeleton,
  TechnicalDetails,
  Textarea,
  useFormErrors,
} from '../../../ui/index.ts';
import { useReleasePlan } from './flow-api.ts';
import { PlanSummary } from './plan-summary.tsx';
import { type ReleaseVersion, versionShort } from './types.ts';

export type ReleaseOperation = { kind: 'rollback'; release: TemplateRelease; generation: number };

const UNKNOWN = 'Unknown user';

export function ReleaseDialog({
  operation,
  templateId,
  scope,
  currentGeneration,
  versions,
  available,
  busy,
  onClose,
  onConfirm,
}: {
  operation: ReleaseOperation;
  templateId: string;
  scope: TemplateReleaseScope;
  currentGeneration: number;
  versions: readonly ReleaseVersion[];
  available: boolean;
  busy: boolean;
  onClose: () => void;
  onConfirm: (operation: ReleaseOperation, reason: string) => Promise<void>;
}) {
  const [reason, setReason] = useState('');
  const check = useFormErrors(reason.trim() ? {} : { reason: 'Give a reason.' });
  const stale = operation.generation !== currentGeneration;
  const version = operation.release.version;
  const plan = useReleasePlan(templateId, scope.orgId, version, [scope.mode]);
  const people = [{ label: 'Published by', value: operation.release.createdByName ?? UNKNOWN }];

  async function submit() {
    if (!available || stale) throw new UserMessageError('Nothing was restored.');
    await onConfirm(operation, reason.trim());
    onClose();
  }

  return (
    <FormDialog
      open
      onOpenChange={(open) => !open && onClose()}
      title={`Restore ${versionShort(versions, version)}`}
      dirty={Boolean(reason.trim())}
      check={check}
      onSubmit={submit}
      submitLabel="Restore"
      busy={busy}
      notice={
        stale || !available ? (
          <>
            {stale ? (
              <Callout tone="danger">
                The release history changed. Close this dialog and review it again.
              </Callout>
            ) : null}
            {!available ? (
              <Callout tone="danger">
                You can no longer publish here. Close this dialog and check your access.
              </Callout>
            ) : null}
          </>
        ) : null
      }
    >
      {({ errors, clear }) => (
        <>
          <KeyValue
            items={[{ label: 'Version', value: versionShort(versions, version) }, ...people]}
          />
          {plan.data ? (
            <PlanSummary plan={plan.data} templateId={templateId} orgId={scope.orgId} />
          ) : plan.isError ? (
            <ErrorState
              inline
              subject="the changes"
              error={plan.error}
              onRetry={() => plan.refetch()}
            />
          ) : (
            <div role="status" aria-busy>
              <span className="sr-only">Loading changes</span>
              <Skeleton className="h-16 w-full" />
            </div>
          )}
          <FormField
            label="Reason"
            required
            error={check.errors.reason ?? errors.reason}
            help="Recorded in the audit log."
          >
            {(control) => (
              <Textarea
                {...control}
                data-autofocus
                maxLength={500}
                value={reason}
                onChange={(event) => {
                  setReason(event.target.value);
                  clear('reason');
                }}
              />
            )}
          </FormField>
          <TechnicalDetails
            items={[
              { label: 'Target release ID', value: operation.release.id },
              { label: 'Version hash', value: version },
              { label: 'Candidate hash', value: operation.release.candidateHash },
              { label: 'Expected generation', value: operation.generation },
              { label: 'New generation', value: operation.generation + 1 },
            ]}
          />
        </>
      )}
    </FormDialog>
  );
}
