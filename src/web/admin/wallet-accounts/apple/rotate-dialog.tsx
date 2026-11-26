import { useState } from 'react';
import { FormDialog, toast, useFormErrors } from '@/web/ui/index.ts';
import { CertificateFields } from './certificate-fields.tsx';
import { useRotateIdentity } from './queries.ts';
import {
  buildRotateBody,
  draftDirty,
  EMPTY_DRAFT,
  type UploadDraft,
  validateUpload,
} from './upload-input.ts';

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
  const check = useFormErrors(validateUpload(draft, false));

  return (
    <FormDialog
      open={open}
      onOpenChange={onOpenChange}
      title="Replace certificate"
      description="Same pass type ID. Existing passes keep working."
      size="lg"
      dirty={draftDirty(draft)}
      check={check}
      submitLabel="Replace certificate"
      busy={rotate.isPending}
      onSubmit={async () => {
        await rotate.mutateAsync(await buildRotateBody(draft));
        toast.success('Certificate replaced');
        onOpenChange(false);
      }}
      onClose={() => setDraft(EMPTY_DRAFT)}
    >
      {({ errors: server, clear }) => (
        <CertificateFields
          autoFocus
          draft={draft}
          errors={{ ...server, ...check.errors } as Record<string, string>}
          patch={(p) => {
            setDraft((d) => ({ ...d, ...p }));
            clear();
          }}
        />
      )}
    </FormDialog>
  );
}
