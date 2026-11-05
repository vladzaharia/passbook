import { useState } from 'react';
import { errorMessage, isApiError } from '@/web/lib/errors.ts';
import { Button, Dialog, DialogContent, Form, toast, useFormErrors } from '@/web/ui/index.ts';
import { CertificateFields } from './certificate-fields.tsx';
import { useRotateIdentity } from './queries.ts';
import {
  buildRotateBody,
  draftDirty,
  EMPTY_DRAFT,
  type UploadDraft,
  validateUpload,
} from './upload-input.ts';

const FORM_ID = 'rotate-identity';

export function RotateIdentityDialog({
  identityId,
  open,
  onOpenChange,
}: {
  identityId: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const rotate = useRotateIdentity(identityId);
  const [draft, setDraft] = useState<UploadDraft>(EMPTY_DRAFT);
  const [server, setServer] = useState<Record<string, string>>({});
  const [formError, setFormError] = useState<string>();
  const check = useFormErrors(validateUpload(draft, false));
  const errors = { ...server, ...check.errors } as Record<string, string>;
  const patch = (p: Partial<UploadDraft>) => {
    setDraft((d) => ({ ...d, ...p }));
    setServer({});
  };

  function close() {
    onOpenChange(false);
    setDraft(EMPTY_DRAFT);
    setServer({});
    check.reset();
    setFormError(undefined);
  }

  async function submit() {
    setFormError(undefined);
    try {
      await rotate.mutateAsync(await buildRotateBody(draft));
      toast.success('Certificate replaced');
      close();
    } catch (cause) {
      if (isApiError(cause) && Object.keys(cause.fields).length > 0) setServer(cause.fields);
      setFormError(errorMessage(cause));
    }
  }

  return (
    <Dialog
      open={open}
      dirty={draftDirty(draft)}
      onOpenChange={(o) => (o ? onOpenChange(true) : close())}
    >
      <DialogContent
        title="Replace certificate"
        description="Same pass type ID. Existing passes keep working."
        size="lg"
        footer={
          <>
            <Button variant="outline" onClick={close}>
              Cancel
            </Button>
            <Button type="submit" form={FORM_ID} loading={rotate.isPending}>
              Replace certificate
            </Button>
          </>
        }
      >
        <Form
          id={FORM_ID}
          className="flex flex-col gap-4 overflow-y-auto"
          {...check.form}
          onValid={() => void submit()}
        >
          <CertificateFields draft={draft} errors={errors} patch={patch} />
          {formError ? (
            <p role="alert" className="text-sm text-danger">
              {formError}
            </p>
          ) : null}
        </Form>
      </DialogContent>
    </Dialog>
  );
}
