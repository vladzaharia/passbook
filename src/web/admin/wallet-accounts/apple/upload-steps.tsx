import { CheckboxField, FormField, Input, Select, WizardReview } from '@/web/ui/index.ts';
import { CertificateFields } from './certificate-fields.tsx';
import type { UploadDraft } from './upload-input.ts';

export const PLATFORM = 'platform';

export const STEPS = [
  { id: 'identity', title: 'Identity', heading: 'Name the identity' },
  { id: 'certificate', title: 'Certificate', heading: 'Add the certificate' },
  { id: 'review', title: 'Review', heading: 'Check and upload' },
] as const;
export type StepId = (typeof STEPS)[number]['id'];

export const HINTS: Partial<Record<StepId, string>> = {
  identity: 'Name the identity.',
  certificate: 'Add the certificate.',
};

/** Where a server field error is fixed. */
export const FIELD_STEP: Record<string, StepId> = {
  label: 'identity',
  orgId: 'identity',
  nfcEnabled: 'identity',
  pkcs12Base64: 'certificate',
  pkcs12Password: 'certificate',
  certificatePem: 'certificate',
  privateKeyPem: 'certificate',
};

type Errors = Record<string, string | undefined>;

export function IdentityStep({
  draft,
  owners,
  org,
  nfc,
  errors,
  onLabel,
  onOrg,
  onNfc,
}: {
  draft: UploadDraft;
  owners: { value: string; label: string }[];
  org: string;
  nfc: boolean;
  errors: Errors;
  onLabel: (label: string) => void;
  onOrg: (org: string) => void;
  onNfc: (nfc: boolean) => void;
}) {
  return (
    <>
      <FormField label="Label" required error={errors.label}>
        {(p) => (
          <Input
            {...p}
            data-autofocus
            autoComplete="off"
            value={draft.label}
            onChange={(e) => onLabel(e.target.value)}
          />
        )}
      </FormField>
      <FormField label="Owner" error={errors.orgId}>
        {(p) => <Select {...p} value={org} onValueChange={onOrg} options={owners} />}
      </FormField>
      <CheckboxField label="NFC enabled" checked={nfc} onCheckedChange={(c) => onNfc(c === true)} />
    </>
  );
}

export function CertificateStep({
  draft,
  errors,
  patch,
}: {
  draft: UploadDraft;
  errors: Errors;
  patch: (p: Partial<UploadDraft>) => void;
}) {
  return (
    <CertificateFields draft={draft} errors={errors as Record<string, string>} patch={patch} />
  );
}

export function UploadReview({
  draft,
  ownerLabel,
  nfc,
  onEdit,
}: {
  draft: UploadDraft;
  ownerLabel: string;
  nfc: boolean;
  onEdit: (step: StepId) => void;
}) {
  return (
    <WizardReview
      onEdit={onEdit}
      sections={[
        {
          id: 'identity',
          title: 'Identity',
          items: [
            { label: 'Label', value: draft.label.trim() },
            { label: 'Owner', value: ownerLabel },
            { label: 'NFC', value: nfc ? 'On' : 'Off' },
          ],
        },
        {
          id: 'certificate',
          title: 'Certificate',
          items:
            draft.mode === 'p12'
              ? [
                  { label: 'Format', value: '.p12 file' },
                  { label: 'File', value: draft.p12?.name ?? '' },
                ]
              : [{ label: 'Format', value: 'PEM certificate and key' }],
        },
      ]}
    />
  );
}
