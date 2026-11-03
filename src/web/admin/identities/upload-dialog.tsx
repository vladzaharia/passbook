import { useState } from 'react';
import { errorMessage, isApiError } from '@/web/lib/errors.ts';
import {
  Button,
  CheckboxField,
  Dialog,
  DialogContent,
  FormField,
  Input,
  Select,
  toast,
} from '@/web/ui/index.ts';
import { useOrgList } from '../orgs/queries.ts';
import { CertificateFields } from './certificate-fields.tsx';
import { useUploadIdentity } from './queries.ts';
import {
  buildUploadBody,
  draftDirty,
  EMPTY_DRAFT as EMPTY,
  type UploadDraft,
  validateUpload,
} from './upload-input.ts';

const PLATFORM = 'platform';

export function UploadIdentityDialog({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const orgs = useOrgList();
  const upload = useUploadIdentity();
  const [draft, setDraft] = useState<UploadDraft>(EMPTY);
  const [org, setOrg] = useState(PLATFORM);
  const [nfc, setNfc] = useState(false);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [formError, setFormError] = useState<string>();
  const patch = (p: Partial<UploadDraft>) => setDraft((d) => ({ ...d, ...p }));

  function close() {
    onOpenChange(false);
    setDraft(EMPTY);
    setOrg(PLATFORM);
    setNfc(false);
    setErrors({});
    setFormError(undefined);
  }

  async function submit() {
    const found = validateUpload(draft);
    setErrors(found);
    setFormError(undefined);
    if (Object.keys(found).length > 0) return;
    try {
      const body = await buildUploadBody(draft, org === PLATFORM ? null : org, nfc);
      await upload.mutateAsync(body);
      toast.success('Identity uploaded');
      close();
    } catch (cause) {
      if (isApiError(cause) && Object.keys(cause.fields).length > 0) {
        setErrors(cause.fields);
        setFormError(cause.message);
      } else {
        setFormError(errorMessage(cause));
      }
    }
  }

  return (
    <Dialog
      open={open}
      dirty={draftDirty(draft) || org !== PLATFORM || nfc}
      onOpenChange={(o) => (o ? onOpenChange(true) : close())}
    >
      <DialogContent
        title="Upload Apple identity"
        size="lg"
        footer={
          <>
            <Button variant="outline" onClick={close}>
              Cancel
            </Button>
            <Button loading={upload.isPending} onClick={() => void submit()}>
              Upload
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
          <FormField label="Label" required error={errors.label}>
            {(p) => (
              <Input
                {...p}
                value={draft.label}
                onChange={(e) => patch({ label: e.target.value })}
              />
            )}
          </FormField>
          <FormField label="Owner">
            {(p) => (
              <Select
                {...p}
                value={org}
                onValueChange={setOrg}
                options={[
                  { value: PLATFORM, label: 'Platform' },
                  ...(orgs.data?.items ?? []).map((o) => ({ value: o.id, label: o.name })),
                ]}
              />
            )}
          </FormField>
          <CertificateFields draft={draft} errors={errors} patch={patch} />
          <CheckboxField
            label="NFC enabled"
            checked={nfc}
            onCheckedChange={(c) => setNfc(c === true)}
          />
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
