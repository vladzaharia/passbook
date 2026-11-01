import { FileDrop, FormField, Input, RadioGroup, Textarea } from '@/web/ui/index.ts';
import { MAX_P12_BYTES, type UploadDraft, type UploadMode } from './upload-input.ts';

/** Format switch plus the .p12 or PEM inputs, shared by upload and rotate. */
export function CertificateFields({
  draft,
  errors,
  patch,
}: {
  draft: UploadDraft;
  errors: Record<string, string>;
  patch: (p: Partial<UploadDraft>) => void;
}) {
  return (
    <>
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
              art="certificate"
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
    </>
  );
}
