import { type FormEvent, useState } from 'react';
import {
  type ConfigureWalletProviderAccount,
  ConfigureWalletProviderAccountSchema,
  type WalletProviderScope,
} from '@/shared/contracts/wallet-providers.ts';
import { Button, FormField, Input, Textarea } from '@/web/ui/index.ts';

const GOOGLE_SCOPE = 'https://www.googleapis.com/auth/wallet_object.issuer';

type FieldName =
  | 'issuerId'
  | 'serviceAccountEmail'
  | 'privateKeyPem'
  | 'partnerId'
  | 'certificateId'
  | 'cardId'
  | 'partnerPrivateKeyPem'
  | 'partnerCertificatePem'
  | 'samsungCertificatePem';

type Field = {
  name: FieldName;
  label: string;
  help?: string;
  pem?: 'PRIVATE KEY' | 'CERTIFICATE';
  validate?: (value: string) => boolean;
  invalid: string;
};

const googleFields: Field[] = [
  {
    name: 'issuerId',
    label: 'Issuer ID',
    help: 'The numeric Google Wallet issuer ID.',
    validate: (value) => /^[0-9]{1,32}$/.test(value) && /[1-9]/.test(value),
    invalid: 'Enter a nonzero numeric issuer ID, up to 32 digits.',
  },
  {
    name: 'serviceAccountEmail',
    label: 'Service account email',
    help: 'The service account must be authorized on this issuer in Google Wallet.',
    validate: (value) =>
      /^[a-zA-Z0-9][a-zA-Z0-9._+-]{0,63}@[a-zA-Z0-9-]+(?:\.[a-zA-Z0-9-]+)*\.gserviceaccount\.com$/.test(
        value,
      ),
    invalid: 'Enter a valid Google service account email.',
  },
  {
    name: 'privateKeyPem',
    label: 'Service account private key (PKCS#8 PEM)',
    pem: 'PRIVATE KEY',
    invalid: 'Enter a PKCS#8 PRIVATE KEY PEM.',
  },
];

const samsungFields: Field[] = [
  {
    name: 'partnerId',
    label: 'Partner ID',
    validate: (value) => /^[A-Za-z0-9_-]{1,32}$/.test(value),
    invalid: 'Enter 1–32 letters, numbers, underscores or hyphens.',
  },
  {
    name: 'certificateId',
    label: 'Certificate ID',
    validate: (value) => /^[A-Za-z0-9]{4}$/.test(value),
    invalid: 'Enter the four-character certificate ID.',
  },
  {
    name: 'cardId',
    label: 'Card ID',
    validate: (value) => /^[A-Za-z0-9_-]{1,32}$/.test(value),
    invalid: 'Enter 1–32 letters, numbers, underscores or hyphens.',
  },
  {
    name: 'partnerPrivateKeyPem',
    label: 'Partner private key (PKCS#8 PEM)',
    pem: 'PRIVATE KEY',
    invalid: 'Enter a PKCS#8 PRIVATE KEY PEM.',
  },
  {
    name: 'partnerCertificatePem',
    label: 'Partner certificate (PEM)',
    pem: 'CERTIFICATE',
    invalid: 'Enter the partner CERTIFICATE PEM.',
  },
  {
    name: 'samsungCertificatePem',
    label: 'Samsung certificate (PEM)',
    help: 'Use the genuine Samsung certificate obtained during partner onboarding.',
    pem: 'CERTIFICATE',
    invalid: 'Enter the Samsung CERTIFICATE PEM.',
  },
];

function validPem(value: string, label: 'PRIVATE KEY' | 'CERTIFICATE'): boolean {
  return (
    value.length <= 32768 &&
    new RegExp(`^-----BEGIN ${label}-----\\s+[A-Za-z0-9+/=\\s]+\\s+-----END ${label}-----$`).test(
      value,
    )
  );
}

/** The form is deliberately uncontrolled: credential values never enter React or query state. */
export function WalletAccountCredentialsForm({
  scope,
  revision,
  rotating,
  busy,
  onSave,
  onCancel,
}: {
  scope: WalletProviderScope;
  revision: number;
  rotating: boolean;
  busy: boolean;
  onSave: (request: ConfigureWalletProviderAccount) => Promise<void>;
  onCancel: () => void;
}) {
  const fields = scope.provider === 'google' ? googleFields : samsungFields;
  const [errors, setErrors] = useState<Partial<Record<FieldName, string>>>({});
  const [formError, setFormError] = useState('');

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (busy) return;
    const form = event.currentTarget;
    const data = new FormData(form);
    const values = Object.fromEntries(
      fields.map((field) => [field.name, String(data.get(field.name) ?? '').trim()]),
    );
    const nextErrors: Partial<Record<FieldName, string>> = {};
    for (const field of fields) {
      const value = values[field.name] ?? '';
      if (!value) nextErrors[field.name] = 'Required.';
      else if (
        field.pem
          ? !validPem(value, field.pem)
          : value.length > (field.name === 'serviceAccountEmail' ? 254 : 255) ||
            (field.validate && !field.validate(value))
      ) {
        nextErrors[field.name] = field.invalid;
      }
    }
    const credentials =
      scope.provider === 'google'
        ? {
            issuerId: values.issuerId,
            serviceAccountEmail: values.serviceAccountEmail,
            privateKeyPem: values.privateKeyPem,
            scopes: [GOOGLE_SCOPE],
          }
        : {
            partnerId: values.partnerId,
            certificateId: values.certificateId,
            cardId: values.cardId,
            partnerPrivateKeyPem: values.partnerPrivateKeyPem,
            partnerCertificatePem: values.partnerCertificatePem,
            samsungCertificatePem: values.samsungCertificatePem,
          };
    const request = ConfigureWalletProviderAccountSchema.safeParse({
      ...scope,
      expectedRevision: revision,
      credentials,
    });
    setErrors(nextErrors);
    if (Object.keys(nextErrors).length || !request.success) {
      setFormError('Check the highlighted fields.');
      return;
    }
    setFormError('');
    // Identifiers and certificates stay for a retry; private keys never outlive the submit.
    for (const field of fields) {
      if (field.pem === 'PRIVATE KEY') {
        const input = form.elements.namedItem(field.name);
        if (input instanceof HTMLTextAreaElement) input.value = '';
      }
    }
    void onSave(request.data);
  }

  return (
    <form
      className="flex flex-col gap-3 border-t border-border pt-4"
      onSubmit={submit}
      noValidate
      autoComplete="off"
    >
      <h4 className="text-sm font-semibold text-fg-strong">
        {rotating ? 'Replace credentials' : 'Configure account'}
      </h4>
      <p className="text-sm text-fg-muted">
        All fields are required. Saved credentials cannot be retrieved. Private keys are cleared on
        save. An existing Google issuer, or Samsung partner and card, cannot be changed.
      </p>
      {fields.map((field) => (
        <FormField
          key={field.name}
          label={field.label}
          help={field.help}
          error={errors[field.name]}
          required
        >
          {(props) =>
            field.pem ? (
              <Textarea
                {...props}
                name={field.name}
                rows={4}
                autoComplete="off"
                spellCheck={false}
                disabled={busy}
                className={field.pem === 'PRIVATE KEY' ? '[-webkit-text-security:disc]' : undefined}
              />
            ) : (
              <Input
                {...props}
                name={field.name}
                autoComplete="off"
                spellCheck={false}
                disabled={busy}
              />
            )
          }
        </FormField>
      ))}
      {formError ? (
        <p role="alert" className="text-sm text-danger">
          {formError}
        </p>
      ) : null}
      <div className="flex flex-wrap gap-2">
        <Button type="submit" size="sm" loading={busy}>
          {rotating ? 'Save replacement credentials' : 'Save credentials'}
        </Button>
        <Button variant="outline" size="sm" disabled={busy} onClick={onCancel}>
          Cancel
        </Button>
      </div>
    </form>
  );
}
