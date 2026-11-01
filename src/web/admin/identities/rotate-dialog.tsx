import { useState } from 'react';
import { toast } from 'sonner';
import { errorMessage, isApiError } from '@/web/lib/errors.ts';
import { Button, Dialog, DialogContent } from '@/web/ui/index.ts';
import { CertificateFields } from './certificate-fields.tsx';
import { useRotateIdentity } from './queries.ts';
import { buildRotateBody, EMPTY_DRAFT, type UploadDraft, validateUpload } from './upload-input.ts';

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
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [formError, setFormError] = useState<string>();
  const patch = (p: Partial<UploadDraft>) => setDraft((d) => ({ ...d, ...p }));

  function close() {
    onOpenChange(false);
    setDraft(EMPTY_DRAFT);
    setErrors({});
    setFormError(undefined);
  }

  async function submit() {
    const found = validateUpload(draft, false);
    setErrors(found);
    setFormError(undefined);
    if (Object.keys(found).length > 0) return;
    try {
      await rotate.mutateAsync(await buildRotateBody(draft));
      toast.success('Certificate replaced');
      close();
    } catch (cause) {
      if (isApiError(cause) && Object.keys(cause.fields).length > 0) setErrors(cause.fields);
      setFormError(errorMessage(cause));
    }
  }

  return (
    <Dialog open={open} onOpenChange={(o) => (o ? onOpenChange(true) : close())}>
      <DialogContent
        title="Rotate certificate"
        description="Same pass type ID. Existing passes keep working."
        size="lg"
        footer={
          <>
            <Button variant="outline" onClick={close}>
              Cancel
            </Button>
            <Button loading={rotate.isPending} onClick={() => void submit()}>
              Replace certificate
            </Button>
          </>
        }
      >
        <form
          className="flex flex-col gap-4 overflow-y-auto"
          onSubmit={(e) => {
            e.preventDefault();
            void submit();
          }}
        >
          <CertificateFields draft={draft} errors={errors} patch={patch} />
          {formError ? (
            <p role="alert" className="text-sm text-danger">
              {formError}
            </p>
          ) : null}
        </form>
      </DialogContent>
    </Dialog>
  );
}
