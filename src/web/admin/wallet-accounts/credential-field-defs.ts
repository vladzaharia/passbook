import { SAMSUNG_CARD_TYPES } from '@/shared/contracts/wallet-providers.ts';

export const GOOGLE_SCOPE = 'https://www.googleapis.com/auth/wallet_object.issuer';

/** The card types a Samsung projection supports: a card row for each beside the default card. */
export const CARD_TYPES = SAMSUNG_CARD_TYPES;
const CARD_ID = /^[A-Za-z0-9_-]{1,32}$/;

export type FieldName =
  | `cardIds.${(typeof CARD_TYPES)[number]}`
  | 'issuerId'
  | 'serviceAccountEmail'
  | 'privateKeyPem'
  | 'partnerId'
  | 'certificateId'
  | 'cardId'
  | 'partnerPrivateKeyPem'
  | 'partnerCertificatePem'
  | 'samsungCertificatePem';

export type Field = {
  name: FieldName;
  /** The FieldGroup it sits under. */
  group: string;
  optional?: boolean;
  label: string;
  help?: string;
  pem?: 'PRIVATE KEY' | 'CERTIFICATE';
  validate?: (value: string) => boolean;
  invalid: string;
};

export const googleFields: Field[] = [
  {
    name: 'issuerId',
    group: 'Issuer',
    label: 'Issuer ID',
    help: 'The numeric Google Wallet issuer ID.',
    validate: (value) => /^[0-9]{1,32}$/.test(value) && /[1-9]/.test(value),
    invalid: 'Enter a nonzero numeric issuer ID, up to 32 digits.',
  },
  {
    name: 'serviceAccountEmail',
    group: 'Issuer',
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
    group: 'Key',
    label: 'Service account private key (PKCS#8 PEM)',
    pem: 'PRIVATE KEY',
    invalid: 'Enter a PKCS#8 PRIVATE KEY PEM.',
  },
];

export const samsungFields: Field[] = [
  {
    name: 'partnerId',
    group: 'Partner',
    label: 'Partner ID',
    validate: (value) => /^[A-Za-z0-9_-]{1,32}$/.test(value),
    invalid: 'Enter 1–32 letters, numbers, underscores or hyphens.',
  },
  {
    name: 'certificateId',
    group: 'Partner',
    label: 'Certificate ID',
    validate: (value) => /^[A-Za-z0-9]{4}$/.test(value),
    invalid: 'Enter the four-character certificate ID.',
  },
  {
    name: 'cardId',
    group: 'Cards',
    label: 'Default card ID',
    help: 'Used by every type without its own card.',
    validate: (value) => CARD_ID.test(value),
    invalid: 'Enter 1–32 letters, numbers, underscores or hyphens.',
  },
  ...CARD_TYPES.map(
    (type): Field => ({
      name: `cardIds.${type}`,
      group: 'Cards',
      label: `Card for ${type} (optional)`,
      optional: true,
      validate: (value) => CARD_ID.test(value),
      invalid: 'Enter 1–32 letters, numbers, underscores or hyphens.',
    }),
  ),
  {
    name: 'partnerPrivateKeyPem',
    group: 'Keys',
    label: 'Partner private key (PKCS#8 PEM)',
    pem: 'PRIVATE KEY',
    invalid: 'Enter a PKCS#8 PRIVATE KEY PEM.',
  },
  {
    name: 'partnerCertificatePem',
    group: 'Keys',
    label: 'Partner certificate (PEM)',
    pem: 'CERTIFICATE',
    invalid: 'Enter the partner CERTIFICATE PEM.',
  },
  {
    name: 'samsungCertificatePem',
    group: 'Keys',
    label: 'Samsung certificate (PEM)',
    help: 'Use the genuine Samsung certificate obtained during partner onboarding.',
    pem: 'CERTIFICATE',
    invalid: 'Enter the Samsung CERTIFICATE PEM.',
  },
];

export function validPem(value: string, label: 'PRIVATE KEY' | 'CERTIFICATE'): boolean {
  return (
    value.length <= 32768 &&
    new RegExp(`^-----BEGIN ${label}-----\\s+[A-Za-z0-9+/=\\s]+\\s+-----END ${label}-----$`).test(
      value,
    )
  );
}
