import { useNavigate } from '@tanstack/react-router';
import { useState } from 'react';
import { errorMessage, isApiError } from '@/web/lib/errors.ts';
import {
  Button,
  CheckboxField,
  Dialog,
  DialogContent,
  Form,
  FormField,
  Input,
  Select,
  useFormErrors,
} from '@/web/ui/index.ts';
import { useOrgList } from '../orgs/queries.ts';
import { markCreated } from '../passes/created.tsx';
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
const FORM_ID = 'upload-identity';

/** Uploads and opens the new identity, whose page says what to do next. */
export function UploadIdentityDialog({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const orgs = useOrgList();
  const upload = useUploadIdentity();
  const navigate = useNavigate();
  const [draft, setDraft] = useState<UploadDraft>(EMPTY);
  const [org, setOrg] = useState(PLATFORM);
  const [nfc, setNfc] = useState(false);
  const [server, setServer] = useState<Record<string, string>>({});
  const [formError, setFormError] = useState<string>();
  const check = useFormErrors(validateUpload(draft));
  const errors = { ...server, ...check.errors } as Record<string, string>;
  const patch = (p: Partial<UploadDraft>) => {
    setDraft((d) => ({ ...d, ...p }));
    setServer({});
  };

  function close() {
    onOpenChange(false);
    setDraft(EMPTY);
    setOrg(PLATFORM);
    setNfc(false);
    setServer({});
    check.reset();
    setFormError(undefined);
  }

  async function submit() {
    setFormError(undefined);
    try {
      const body = await buildUploadBody(draft, org === PLATFORM ? null : org, nfc);
      const created = await upload.mutateAsync(body);
      close();
      markCreated(`identity:${created.id}`);
      void navigate({ to: '/admin/identities/$identityId', params: { identityId: created.id } });
    } catch (cause) {
      if (isApiError(cause) && Object.keys(cause.fields).length > 0) setServer(cause.fields);
      setFormError(errorMessage(cause));
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
            <Button type="submit" form={FORM_ID} loading={upload.isPending}>
              Upload
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
        </Form>
      </DialogContent>
    </Dialog>
  );
}
