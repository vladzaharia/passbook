import { useState } from 'react';
import { toast } from 'sonner';
import { errorMessage, isApiError } from '@/web/lib/errors.ts';
import {
  Button,
  CheckboxField,
  Dialog,
  DialogContent,
  FileDrop,
  FormField,
  Input,
  RadioGroup,
  Select,
  Textarea,
} from '@/web/ui/index.ts';
import { useOrgList } from '../orgs/queries.ts';
import { useUploadIdentity } from './queries.ts';
import {
  buildUploadBody,
  MAX_P12_BYTES,
  type UploadDraft,
  type UploadMode,
  validateUpload,
} from './upload-input.ts';

const PLATFORM = 'platform';
const EMPTY: UploadDraft = {
  mode: 'p12',
  label: '',
  certificatePem: '',
  privateKeyPem: '',
  p12: undefined,
  p12Password: '',
};

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
    <Dialog open={open} onOpenChange={(o) => (o ? onOpenChange(true) : close())}>
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
          <RadioGroup
            legend="Format"
            orientation="horizontal"
            value={draft.mode}
            onValueChange={(v) => patch({ mode: v as UploadMode })}
            options={[
              { value: 'p12', label: '.p12 file' },
              { value: 'pem', label: 'PEM certificate and key' },
            ]}
          />
          {draft.mode === 'p12' ? (
            <>
              <div>
                <FileDrop
                  accept=".p12,.pfx"
                  maxBytes={MAX_P12_BYTES}
                  label={draft.p12 ? draft.p12.name : 'Choose a .p12 file'}
                  onFiles={([file]) => patch({ p12: file })}
                />
                {errors.p12 || errors.pkcs12Base64 ? (
                  <p role="alert" className="mt-1.5 text-xs text-danger">
                    {errors.p12 ?? errors.pkcs12Base64}
                  </p>
                ) : null}
              </div>
              <FormField label="Password" error={errors.pkcs12Password}>
                {(p) => (
                  <Input
                    {...p}
                    type="password"
                    autoComplete="off"
                    value={draft.p12Password}
                    onChange={(e) => patch({ p12Password: e.target.value })}
                  />
                )}
              </FormField>
            </>
          ) : (
            <>
              <FormField label="Certificate (PEM)" error={errors.certificatePem}>
                {(p) => (
                  <Textarea
                    {...p}
                    className="font-mono text-xs"
                    spellCheck={false}
                    value={draft.certificatePem}
                    onChange={(e) => patch({ certificatePem: e.target.value })}
                  />
                )}
              </FormField>
              <FormField label="Private key (PEM)" error={errors.privateKeyPem}>
                {(p) => (
                  <Textarea
                    {...p}
                    className="font-mono text-xs"
                    spellCheck={false}
                    autoComplete="off"
                    value={draft.privateKeyPem}
                    onChange={(e) => patch({ privateKeyPem: e.target.value })}
                  />
                )}
              </FormField>
            </>
          )}
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
