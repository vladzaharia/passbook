import { useState } from 'react';
import { RETENTION_COPY } from '@/shared/copy/retention.ts';
import {
  EntityPicker,
  FormDialog,
  FormField,
  RadioGroup,
  Textarea,
  toast,
  useFormErrors,
} from '@/web/ui/index.ts';
import { type RetentionScope, usePlaceHold } from './queries.ts';

const SCOPES = [
  { value: 'org', label: RETENTION_COPY.placeOrg, hint: 'Every record of the organization.' },
  { value: 'pass', label: RETENTION_COPY.placePass, hint: 'One pass and its history.' },
];

export function PlaceHoldDialog({
  scope,
  orgId,
  passId: fixedPass,
  open,
  onOpenChange,
}: {
  scope: RetentionScope;
  orgId: string;
  /** A hold on this pass only: the scope choice is not offered. */
  passId?: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const place = usePlaceHold(scope, orgId);
  const [target, setTarget] = useState(fixedPass ? 'pass' : 'org');
  const [picked, setPicked] = useState<string>();
  const passId = fixedPass ?? picked;
  const [reason, setReason] = useState('');
  const check = useFormErrors({
    ...(reason.trim() ? {} : { reason: 'Give a reason.' }),
    ...(target === 'pass' && !passId ? { passId: 'Choose a pass.' } : {}),
  });

  async function submit() {
    await place.mutateAsync({ reason: reason.trim(), ...(target === 'pass' ? { passId } : {}) });
    toast.success('Hold placed. Admins were emailed.');
    onOpenChange(false);
  }

  return (
    <FormDialog
      open={open}
      onOpenChange={onOpenChange}
      title={RETENTION_COPY.place}
      description="Deletion pauses for what you hold. Every organization admin is emailed."
      dirty={reason.trim() !== ''}
      check={check}
      onSubmit={submit}
      submitLabel={RETENTION_COPY.place}
      onClose={() => {
        setTarget(fixedPass ? 'pass' : 'org');
        setPicked(undefined);
        setReason('');
      }}
    >
      {({ errors: server }) => (
        <>
          {fixedPass ? null : (
            <RadioGroup legend="Scope" options={SCOPES} value={target} onValueChange={setTarget} />
          )}
          {target === 'pass' && !fixedPass ? (
            <FormField label="Pass" required error={check.errors.passId ?? server.passId}>
              {(p) => (
                <EntityPicker
                  {...p}
                  kind="pass"
                  value={passId}
                  onValueChange={setPicked}
                  placeholder="Search passes"
                />
              )}
            </FormField>
          ) : null}
          <FormField
            label="Reason"
            required
            error={check.errors.reason ?? server.reason}
            help="Seen by organization admins. Not stored in the audit log."
          >
            {(p) => (
              <Textarea
                {...p}
                data-autofocus
                rows={3}
                maxLength={500}
                value={reason}
                onChange={(e) => setReason(e.target.value)}
              />
            )}
          </FormField>
        </>
      )}
    </FormDialog>
  );
}
