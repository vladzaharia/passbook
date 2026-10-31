import { PERSONALIZATION_FIELDS } from './constants.ts';
import { decodeStrings, type ParsedStrings, parseStrings } from './strings.ts';
import { isObject, type ValidationContext } from './util.ts';
import type { ParsedImage, ValidatableAsset } from './validate-images.ts';

const STRINGS_FILE = /^([A-Za-z0-9_-]+)\.lproj\/pass\.strings$/;

export interface PackageContents {
  /** Bytes or text of pass.strings files, by path. */
  strings?: Record<string, Uint8Array | string>;
  /** Parsed personalization.json. */
  personalization?: unknown;
  /** The pass is the one returned after personalization. */
  personalized?: boolean;
}

/** Strings files must decode, parse and carry the same key set in every locale. */
export function validateLocalization(
  ctx: ValidationContext,
  assets: ValidatableAsset[],
  contents: PackageContents,
): void {
  const { error, warn } = ctx;
  const parsed = new Map<string, ParsedStrings>();
  for (const asset of assets) {
    const m = STRINGS_FILE.exec(asset.name);
    if (!m) continue;
    const source = contents.strings?.[asset.name];
    if (source === undefined) continue;
    let text: string;
    if (typeof source === 'string') text = source;
    else {
      const decoded = decodeStrings(source);
      if (!decoded.ok) {
        error('STRINGS_ENCODING', decoded.message, asset.name);
        continue;
      }
      text = decoded.text;
      if (decoded.encoding === 'utf-8' && !decoded.bom && /[^\0-\x7f]/.test(text))
        warn('STRINGS_ENCODING', 'Non-ASCII text should be UTF-16 with a BOM.', asset.name);
    }
    const result = parseStrings(text);
    if (result.error) {
      error('STRINGS_SYNTAX', `${result.error.message} (line ${result.error.line})`, asset.name);
      continue;
    }
    for (const key of result.duplicates)
      warn('STRINGS_DUPLICATE', `Key "${key}" is defined more than once.`, asset.name);
    parsed.set(asset.name, result);
  }
  if (parsed.size < 2) return;
  const union = new Set([...parsed.values()].flatMap((p) => [...p.entries.keys()]));
  for (const [name, result] of parsed) {
    const missing = [...union].filter((k) => !result.entries.has(k));
    if (missing.length)
      error(
        'STRINGS_KEYS',
        `Missing keys: ${missing.slice(0, 5).join(', ')}${missing.length > 5 ? ', ...' : ''}.`,
        name,
      );
  }
}

/** personalization.json: shape, NFC entitlement, logo, web service. */
export function validatePersonalization(
  ctx: ValidationContext,
  assets: ValidatableAsset[],
  images: ParsedImage[],
  contents: PackageContents,
): void {
  const { pass, identity, error, warn } = ctx;
  const present =
    contents.personalization !== undefined || assets.some((a) => a.name === 'personalization.json');
  if (contents.personalized) {
    if (present)
      error(
        'PERSONALIZATION',
        'A personalized pass must not contain personalization.json.',
        'personalization.json',
      );
    return;
  }
  if (!present) {
    if (images.some((i) => i.slot === 'personalizationLogo'))
      warn('UNUSED_IMAGE', 'personalizationLogo is used only with personalization.json.');
    return;
  }
  if (!identity.nfcEnabled)
    error(
      'NFC_NOT_ENTITLED',
      'Personalization requires an NFC-enabled signing identity.',
      'personalization.json',
    );
  if (!images.some((i) => i.slot === 'personalizationLogo'))
    error(
      'MISSING_IMAGE',
      'Personalization requires personalizationLogo.png.',
      'personalizationLogo.png',
    );
  if (typeof pass.webServiceURL !== 'string' || pass.webServiceURL === '')
    error('PERSONALIZATION', 'Personalization requires webServiceURL.', 'webServiceURL');
  if (!isObject(pass.nfc)) warn('PERSONALIZATION', 'Personalization is for NFC passes.', 'nfc');

  const data = contents.personalization;
  if (data === undefined) return;
  const path = 'personalization.json';
  if (!isObject(data)) {
    error('PERSONALIZATION', 'personalization.json must be an object.', path);
    return;
  }
  for (const key of Object.keys(data))
    if (!['requiredPersonalizationFields', 'description', 'termsAndConditions'].includes(key))
      warn('UNKNOWN_KEY', `Unknown key ${key}.`, `${path}.${key}`);
  const fields = data.requiredPersonalizationFields;
  if (
    !Array.isArray(fields) ||
    fields.length === 0 ||
    !fields.every((f) => (PERSONALIZATION_FIELDS as readonly unknown[]).includes(f))
  )
    error(
      'PERSONALIZATION',
      'requiredPersonalizationFields needs one or more known field names.',
      `${path}.requiredPersonalizationFields`,
    );
  if (typeof data.description !== 'string' || data.description === '')
    error('PERSONALIZATION', 'description is required.', `${path}.description`);
  if (data.termsAndConditions !== undefined && typeof data.termsAndConditions !== 'string')
    error('PERSONALIZATION', 'termsAndConditions must be a string.', `${path}.termsAndConditions`);
}
