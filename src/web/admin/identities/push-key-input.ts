/** A .p8 is under 400 bytes; 4 KB leaves room for stray whitespace. */
export const MAX_P8_BYTES = 4_000;

/** Apple names downloads `AuthKey_<KEYID>.p8`; the ID is the 10 characters after the underscore. */
export function keyIdFromFilename(name: string): string {
  return /^AuthKey_([A-Z0-9]{10})\.p8$/i.exec(name)?.[1]?.toUpperCase() ?? '';
}

export interface PushKeyDraft {
  file: File | undefined;
  keyId: string;
}

export const EMPTY_PUSH_DRAFT: PushKeyDraft = { file: undefined, keyId: '' };

export function validatePushKey(d: PushKeyDraft): Record<string, string> {
  const errors: Record<string, string> = {};
  if (!d.file) errors.p8 = 'Choose a .p8 file.';
  else if (d.file.size === 0) errors.p8 = 'File is empty.';
  else if (d.file.size > MAX_P8_BYTES) errors.p8 = 'File is too large. A .p8 is under 1 KB.';
  if (!/^[A-Z0-9]{10}$/.test(d.keyId.trim()))
    errors.keyId = 'Enter the 10-character key ID from Apple Developer.';
  return errors;
}
