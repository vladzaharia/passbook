import { useState } from 'react';
import { RETENTION_COPY } from '@/shared/copy/retention.ts';
import { errorMessage, isApiError } from '@/web/lib/errors.ts';
import {
  Button,
  Dialog,
  DialogContent,
  EntityPicker,
  Form,
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
  open,
  onOpenChange,
}: {
  scope: RetentionScope;
  orgId: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const place = usePlaceHold(scope, orgId);
  const [target, setTarget] = useState('org');
  const [passId, setPassId] = useState<string>();
  const [reason, setReason] = useState('');
  const [server, setServer] = useState<Record<string, string>>({});
  const [formError, setFormError] = useState<string>();
  const check = useFormErrors({
    ...(reason.trim() ? {} : { reason: 'Give a reason.' }),
    ...(target === 'pass' && !passId ? { passId: 'Choose a pass.' } : {}),
  });
  const errors: Record<string, string | undefined> = { ...server, ...check.errors };

  function close() {
    onOpenChange(false);
    setTarget('org');
    setPassId(undefined);
    setReason('');
    setServer({});
    setFormError(undefined);
    check.reset();
  }

  async function submit() {
    setFormError(undefined);
    try {
      await place.mutateAsync({
        reason: reason.trim(),
        ...(target === 'pass' ? { passId } : {}),
      });
      toast.success('Hold placed. Admins were emailed.');
      close();
    } catch (cause) {
      if (isApiError(cause) && Object.keys(cause.fields).length > 0) setServer(cause.fields);
      else setFormError(errorMessage(cause));
    }
  }

  return (
    <Dialog
      open={open}
      dirty={reason.trim() !== ''}
      onOpenChange={(o) => (o ? onOpenChange(true) : close())}
    >
      <DialogContent
        size="md"
        title={RETENTION_COPY.place}
        description="Deletion pauses for what you hold. Every organization admin is emailed."
        footer={
          <>
            <Button variant="outline" onClick={close}>
              Cancel
            </Button>
            <Button type="submit" form="place-hold" loading={place.isPending}>
              {RETENTION_COPY.place}
            </Button>
          </>
        }
      >
        <Form id="place-hold" className="flex flex-col gap-4" {...check.form} onValid={submit}>
          <RadioGroup
            legend="Scope"
            options={SCOPES}
            value={target}
            onValueChange={(v) => {
              setTarget(v);
              setServer({});
            }}
          />
          {target === 'pass' ? (
            <FormField label="Pass" required error={errors.passId}>
              {(p) => (
                <EntityPicker
                  {...p}
                  kind="pass"
                  value={passId}
                  onValueChange={setPassId}
                  placeholder="Search passes"
                />
              )}
            </FormField>
          ) : null}
          <FormField
            label="Reason"
            required
            error={errors.reason}
            help="Seen by organization admins. Not stored in the audit log."
          >
            {(p) => (
              <Textarea
                {...p}
                data-autofocus
                rows={3}
                maxLength={500}
                value={reason}
                onChange={(e) => {
                  setReason(e.target.value);
                  setServer({});
                }}
              />
            )}
          </FormField>
          {formError ? <p className="text-sm text-danger">{formError}</p> : null}
        </Form>
      </DialogContent>
    </Dialog>
  );
}
