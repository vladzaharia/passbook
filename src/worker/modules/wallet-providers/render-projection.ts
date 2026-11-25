import { isPlainLine, measure } from '../../../passkit/wallets/text.ts';
import type { GoogleGenericProjection } from './google-projection.ts';
import {
  type GoogleProjection,
  type NativeProjection,
  NativeProjectionSchema,
} from './projection-contract.ts';

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

/** Do not silently discard markup, controls, or content a provider would truncate. */
function plain(value: unknown, max: number): value is string {
  return typeof value === 'string' && isPlainLine(value) && measure(value, 'chars') <= max;
}

/** Recheck materialized pass semantics, not only the template that was reviewed. */
function sourceOf(projection: GoogleProjection, input: unknown): Source | null {
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
      measure(item.message, 'bytes') > 4096 ||
      /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/u.test(
        item.message,
      ) ||
      (item.altText !== undefined && !plain(item.altText, 500))
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
  projection: NativeProjection,
  passJson: unknown,
): RenderedGoogleProjection | null {
  // Schema 2 is compiled by the typed runtime, never rendered from field mappings.
  if (projection.schema !== 1 || projection.provider !== 'google') return null;
  const source = sourceOf(projection, passJson);
  if (!source) return null;
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
  if (measure(JSON.stringify(objectProjection), 'bytes') > 32_768) return null;
  return { objectProjection, classProjection: {} };
}

/** Whether a materialized pass can be offered under this projection. Schema 2 is compiled by the typed runtimes. */
export function canRenderProjection(projection: NativeProjection, passJson: unknown): boolean {
  if (projection.schema === 2) return true;
  // Samsung field mappings are retired; a Google schema 1 mapping renders only for the legacy tests.
  return projection.provider === 'google' && renderGoogleProjection(projection, passJson) !== null;
}
