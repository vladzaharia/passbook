import { useId, useState } from 'react';
import type {
  TemplateApproval,
  TemplateCandidate,
  TemplateRelease,
  TemplateReleaseScope,
} from '@/shared/contracts/template-releases.ts';
import { errorMessage } from '../../../lib/errors.ts';
import {
  Button,
  Callout,
  Dialog,
  DialogContent,
  ErrorState,
  FormField,
  KeyValue,
  Skeleton,
  TechnicalDetails,
  Textarea,
} from '../../../ui/index.ts';
import { useReleasePlan } from './flow-api.ts';
import { PlanSummary } from './plan-summary.tsx';
import { type ReleaseVersion, versionShort } from './types.ts';

export type ReleaseOperation =
  | {
      kind: 'publish';
      candidate: TemplateCandidate;
      approval: TemplateApproval;
      generation: number;
    }
  | { kind: 'rollback'; release: TemplateRelease; generation: number };

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
  const formId = useId();
  const [reason, setReason] = useState('');
  const [error, setError] = useState<string>();
  const stale = operation.generation !== currentGeneration;
  const rollback = operation.kind === 'rollback';
  const version = rollback ? operation.release.version : operation.candidate.version;
  const plan = useReleasePlan(templateId, scope.orgId, version, [scope.mode]);
  const hash = rollback ? operation.release.candidateHash : operation.candidate.candidateHash;
  const id = rollback ? operation.release.id : operation.candidate.id;
  const people = rollback
    ? [{ label: 'Published by', value: operation.release.createdByName ?? UNKNOWN }]
    : [
        { label: 'Author', value: operation.candidate.authorName ?? UNKNOWN },
        { label: 'Approved by', value: operation.approval.reviewerName ?? UNKNOWN },
      ];

  async function submit() {
    setError(undefined);
    try {
      await onConfirm(operation, reason.trim());
      onClose();
    } catch (cause) {
      setError(errorMessage(cause));
    }
  }

  return (
    <Dialog
      open
      dirty={rollback && Boolean(reason.trim())}
      onOpenChange={(open) => {
        if (!open && !busy) onClose();
      }}
    >
      <DialogContent
        title={rollback ? `Restore ${versionShort(versions, version)}` : 'Publish release'}
        footer={
          <>
            <Button variant="outline" disabled={busy} onClick={onClose}>
              Cancel
            </Button>
            <Button
              type="submit"
              form={formId}
              loading={busy}
              disabled={!available || stale || (rollback && !reason.trim())}
            >
              {rollback ? 'Restore' : 'Confirm publish'}
            </Button>
          </>
        }
      >
        <form
          id={formId}
          className="grid gap-4"
          onSubmit={(event) => {
            event.preventDefault();
            if (available && !stale && !busy && (!rollback || reason.trim())) void submit();
          }}
        >
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
          {rollback ? (
            <FormField label="Reason" required help="Recorded in the audit log.">
              {(control) => (
                <Textarea
                  {...control}
                  required
                  maxLength={500}
                  value={reason}
                  onChange={(event) => {
                    setReason(event.target.value);
                    setError(undefined);
                  }}
                />
              )}
            </FormField>
          ) : null}
          <TechnicalDetails
            items={[
              { label: rollback ? 'Target release ID' : 'Candidate ID', value: id },
              { label: 'Version hash', value: version },
              { label: 'Candidate hash', value: hash },
              { label: 'Expected generation', value: operation.generation },
              { label: 'New generation', value: operation.generation + 1 },
              ...(rollback ? [] : [{ label: 'Approval ID', value: operation.approval.id }]),
            ]}
          />
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
          {error ? <Callout tone="danger">{error}</Callout> : null}
        </form>
      </DialogContent>
    </Dialog>
  );
}
