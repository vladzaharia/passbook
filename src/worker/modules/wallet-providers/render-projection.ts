import type { GoogleGenericProjection } from './google-projection.ts';
import {
  type GoogleProjection,
  type NativeProjection,
  NativeProjectionSchema,
  type SamsungProjection,
} from './projection-contract.ts';
import type { SamsungCardProjection } from './samsung-token.ts';

interface Field {
  key: string;
  value: string;
  label?: string;
}
interface Source {
  organization: string;
  description: string;
  fields: Field[];
  title: Field;
  barcode: { message: string; altText?: string } | null;
}

const isObject = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);
const only = (value: Record<string, unknown>, allowed: readonly string[]) =>
  Object.keys(value).every((key) => allowed.includes(key));
const encoder = new TextEncoder();

/** Do not silently discard markup, controls, or content a provider would truncate. */
function plain(value: unknown, max: number): value is string {
  if (typeof value !== 'string' || value.trim().length === 0 || /<\/?[A-Za-z][^>]*>/u.test(value))
    return false;
  let length = 0;
  for (const character of value) {
    const code = character.charCodeAt(0);
    if (++length > max || code < 0x20 || (code >= 0x7f && code <= 0x9f)) return false;
  }
  return true;
}

/** Recheck materialized pass semantics, not only the template that was reviewed. */
function sourceOf(projection: NativeProjection, input: unknown): Source | null {
  if (
    !NativeProjectionSchema.safeParse(projection).success ||
    !isObject(input) ||
    !only(input, [
      'formatVersion',
      'passTypeIdentifier',
      'teamIdentifier',
      'serialNumber',
      'organizationName',
      'description',
      'generic',
      'barcode',
      'barcodes',
      'authenticationToken',
      'webServiceURL',
    ]) ||
    input.formatVersion !== 1 ||
    !plain(input.organizationName, 35) ||
    !plain(input.description, 500) ||
    !isObject(input.generic) ||
    !only(input.generic, [
      'headerFields',
      'primaryFields',
      'secondaryFields',
      'auxiliaryFields',
      'backFields',
    ])
  )
    return null;

  const byKey = new Map<string, Field>();
  for (const group of Object.values(input.generic)) {
    if (!Array.isArray(group)) return null;
    for (const candidate of group) {
      if (
        !isObject(candidate) ||
        !only(candidate, ['key', 'value', 'label', '_id']) ||
        typeof candidate.key !== 'string' ||
        !candidate.key ||
        byKey.has(candidate.key)
      )
        return null;
      const value =
        typeof candidate.value === 'number' && Number.isFinite(candidate.value)
          ? String(candidate.value)
          : candidate.value;
      if (!plain(value, 500) || (candidate.label !== undefined && !plain(candidate.label, 35)))
        return null;
      byKey.set(candidate.key, {
        key: candidate.key,
        value,
        ...(typeof candidate.label === 'string' ? { label: candidate.label } : {}),
      });
    }
  }
  if (byKey.size !== projection.fields.length || projection.fields.some((key) => !byKey.has(key)))
    return null;
  const title = byKey.get(projection.titleField);
  if (!title) return null;
  const fields = projection.fields.map((key) => byKey.get(key) as Field);

  if (input.barcode !== undefined && input.barcodes !== undefined) return null;
  const barcodes =
    input.barcodes === undefined
      ? input.barcode === undefined
        ? []
        : [input.barcode]
      : input.barcodes;
  if (!Array.isArray(barcodes) || barcodes.length !== (projection.barcode === 'qr' ? 1 : 0))
    return null;
  let barcode: Source['barcode'] = null;
  if (barcodes.length) {
    const item: unknown = barcodes[0];
    if (
      !isObject(item) ||
      !only(item, ['format', 'message', 'messageEncoding', 'altText']) ||
      item.format !== 'PKBarcodeFormatQR' ||
      typeof item.messageEncoding !== 'string' ||
      item.messageEncoding.toLowerCase() !== 'utf-8' ||
      typeof item.message !== 'string' ||
      !item.message ||
      encoder.encode(item.message).byteLength > 4096 ||
      /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/u.test(
        item.message,
      ) ||
      (item.altText !== undefined &&
        (projection.provider === 'samsung' || !plain(item.altText, 500)))
    )
      return null;
    barcode = {
      message: item.message,
      ...(typeof item.altText === 'string' ? { altText: item.altText } : {}),
    };
  }
  return {
    organization: input.organizationName,
    description: input.description,
    fields,
    title,
    barcode,
  };
}

function localized(language: string, value: string) {
  return { defaultValue: { language, value } };
}

export interface RenderedGoogleProjection {
  objectProjection: GoogleGenericProjection;
  classProjection: GoogleGenericProjection;
}

/** Project only values explicitly covered by a previously approved native mapping. */
export function renderGoogleProjection(
  projection: GoogleProjection,
  passJson: unknown,
): RenderedGoogleProjection | null {
  const source = sourceOf(projection, passJson);
  if (!source || projection.provider !== 'google') return null;
  const textModulesData = source.fields.map((field, index) => {
    const module: Record<string, string> = { id: `f${index}`, body: field.value };
    if (field.label !== undefined) module.header = field.label;
    return module;
  });
  textModulesData.push({ id: 'description', header: 'Description', body: source.description });
  let barcode: Record<string, string> | undefined;
  if (source.barcode) {
    barcode = { type: 'QR_CODE', renderEncoding: 'UTF_8', value: source.barcode.message };
    if (source.barcode.altText !== undefined) barcode.alternateText = source.barcode.altText;
  }
  const objectProjection: GoogleGenericProjection = {
    genericType: 'GENERIC_OTHER',
    state: 'ACTIVE',
    cardTitle: localized(projection.language, source.organization),
    header: localized(projection.language, source.title.value),
    logo: {
      sourceUri: { uri: projection.logoUrl },
      contentDescription: localized(projection.language, source.organization),
    },
    textModulesData,
    ...(barcode ? { barcode } : {}),
  };
  if (encoder.encode(JSON.stringify(objectProjection)).byteLength > 32_768) return null;
  return { objectProjection, classProjection: {} };
}

/** Validate the current materialization without inventing a provider reference. */
function samsungContent(
  projection: SamsungProjection,
  passJson: unknown,
): {
  source: Source;
  extendedFields: string;
} | null {
  const source = sourceOf(projection, passJson);
  if (
    !source ||
    projection.provider !== 'samsung' ||
    !plain(source.organization, 32) ||
    !plain(source.title.value, 32) ||
    source.fields.some((field) => field.label === undefined)
  )
    return null;
  const extendedFields = JSON.stringify([
    ...source.fields.map((field, index) => ({
      label: field.label,
      value: field.value,
      order: index + 1,
    })),
    { label: 'Description', value: source.description, order: source.fields.length + 1 },
  ]);
  return encoder.encode(extendedFields).byteLength <= 1024 ? { source, extendedFields } : null;
}

export function canRenderSamsungProjection(
  projection: SamsungProjection,
  passJson: unknown,
): boolean {
  return samsungContent(projection, passJson) !== null;
}

/** Samsung's loyalty attributes are flat paths; extendedFields is a JSON-encoded string. */
export function renderSamsungProjection(
  projection: SamsungProjection,
  passJson: unknown,
  refId: string,
  createdAt: number,
  now: number,
): SamsungCardProjection | null {
  if (
    !/^[A-Za-z0-9_-]{32}$/.test(refId) ||
    !Number.isSafeInteger(createdAt) ||
    !Number.isSafeInteger(now) ||
    createdAt < 0 ||
    now < createdAt
  )
    return null;
  const content = samsungContent(projection, passJson);
  if (!content) return null;
  const { source, extendedFields } = content;
  return {
    card: {
      type: projection.cardType,
      subType: projection.cardSubType,
      data: [
        {
          refId,
          createdAt,
          updatedAt: now,
          state: 'ACTIVE',
          language: projection.language,
          attributes: {
            title: source.title.value,
            providerName: source.organization,
            logoImage: projection.logoUrl,
            appLinkLogo: projection.appLinkLogo,
            appLinkName: projection.appLinkName,
            appLinkData: projection.appLinkData,
            extendedFields,
            ...(source.barcode
              ? {
                  'barcode.value': source.barcode.message,
                  'barcode.serialType': 'QRCODE',
                  'barcode.ptFormat': 'QRCODE',
                  'barcode.ptSubFormat': 'QR_CODE',
                }
              : {}),
          },
        },
      ],
    },
  };
}
