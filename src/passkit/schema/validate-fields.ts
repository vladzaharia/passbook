import type { PassStyle } from '../types.ts';
import {
  DATA_DETECTOR_TYPES,
  DATE_STYLES,
  FIELD_GROUPS,
  type FieldGroup,
  NUMBER_STYLES,
  SQUARE_BARCODE_FORMATS,
  STYLE_DICT_KEYS,
  TEXT_ALIGNMENTS,
  TRANSIT_TYPES,
} from './constants.ts';
import { isObject, parseIsoDate, type ValidationContext } from './util.ts';
import { validateSemantics } from './validate-semantics.ts';

const FIELD_KEYS = new Set([
  'key',
  'value',
  'label',
  'attributedValue',
  'changeMessage',
  'dataDetectorTypes',
  'textAlignment',
  'dateStyle',
  'timeStyle',
  'isRelative',
  'ignoresTimeZone',
  'currencyCode',
  'numberStyle',
  'row',
  'semantics',
  '_id',
]);
const LINK_PROTOCOLS = new Set(['https:', 'tel:', 'mailto:']);

type Limits = Partial<Record<FieldGroup, number>>;
/** Fields drawn on the face per group; the designer stops adding at these. */
export const LIMITS: Record<PassStyle, Limits> = {
  generic: { headerFields: 3, primaryFields: 1, secondaryFields: 4, auxiliaryFields: 4 },
  storeCard: { headerFields: 3, primaryFields: 1 },
  coupon: { headerFields: 3, primaryFields: 1 },
  eventTicket: { headerFields: 3, primaryFields: 1, secondaryFields: 4 },
  boardingPass: { headerFields: 3, primaryFields: 2, secondaryFields: 4, auxiliaryFields: 5 },
  posterGeneric: { headerFields: 1, primaryFields: 4, footerFields: 1 },
};

/** Fields past these counts are kept in pass details but not drawn on the face. */
export function validateFieldCounts(
  ctx: ValidationContext,
  style: PassStyle,
  dict: Record<string, unknown>,
): void {
  const count = (group: FieldGroup) =>
    Array.isArray(dict[group]) ? (dict[group] as unknown[]) : [];
  for (const [group, max] of Object.entries(LIMITS[style]) as [FieldGroup, number][]) {
    if (count(group).length > max)
      ctx.warn('FIELD_COUNT', `${group} has more than ${max} fields.`, `${style}.${group}`);
  }
  if (style === 'eventTicket') {
    const aux = count('auxiliaryFields');
    for (const row of [0, 1]) {
      const inRow = aux.filter((f) => (isObject(f) && f.row === 1 ? 1 : 0) === row).length;
      if (inRow > 4)
        ctx.warn(
          'FIELD_COUNT',
          `auxiliaryFields row ${row} has more than 4 fields.`,
          `${style}.auxiliaryFields`,
        );
    }
  }
  if (style === 'storeCard' || style === 'coupon') {
    if (count('secondaryFields').length + count('auxiliaryFields').length > 4)
      ctx.warn('FIELD_COUNT', 'secondaryFields and auxiliaryFields share 4 slots.', style);
  }
  if (style === 'generic') {
    const barcodes = Array.isArray(ctx.pass.barcodes) ? ctx.pass.barcodes : [];
    const first = barcodes[0];
    if (
      first &&
      SQUARE_BARCODE_FORMATS.has(String(first.format)) &&
      count('secondaryFields').length + count('auxiliaryFields').length > 4
    )
      ctx.warn('FIELD_COUNT', 'A square barcode leaves 4 secondary and auxiliary slots.', style);
  }
  if (style === 'posterGeneric') {
    for (const group of ['secondaryFields', 'auxiliaryFields'] as const)
      if (count(group).length)
        ctx.warn(
          'FIELD_NOT_SHOWN',
          `${group} are not shown on poster generic passes.`,
          `${style}.${group}`,
        );
  }
}

function checkAttributedValue(ctx: ValidationContext, value: unknown, path: string): void {
  if (typeof value !== 'string') {
    ctx.error('FIELD_TYPE', 'attributedValue must be a string.', path);
    return;
  }
  for (const tag of value.matchAll(/<\/?\s*([a-z][a-z0-9]*)/gi)) {
    if (tag[1]?.toLowerCase() !== 'a') {
      ctx.warn('ATTRIBUTED_TAGS', 'Only <a href> is supported.', path);
      break;
    }
  }
  for (const match of value.matchAll(/href\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/gi)) {
    const href = match[1] ?? match[2] ?? match[3] ?? '';
    let protocol: string | undefined;
    try {
      protocol = new URL(href).protocol;
    } catch {
      protocol = undefined;
    }
    if (protocol === undefined) ctx.error('LINK', 'Invalid link.', path);
    else if (!LINK_PROTOCOLS.has(protocol))
      ctx.error('LINK', 'Links must use https, tel or mailto.', path);
  }
}

function inEnum(values: readonly string[], value: unknown): boolean {
  return typeof value === 'string' && values.includes(value);
}

export function validateField(
  ctx: ValidationContext,
  field: unknown,
  group: FieldGroup,
  style: PassStyle,
  path: string,
): void {
  if (!isObject(field) || typeof field.key !== 'string' || field.key === '') {
    ctx.error('FIELD_KEY', 'Every field needs a key.', path);
    return;
  }
  const { error, warn } = ctx;
  for (const key of Object.keys(field))
    if (!FIELD_KEYS.has(key)) warn('UNKNOWN_KEY', `Unknown key ${key}.`, `${path}.${key}`);

  const value = field.value;
  if (typeof value !== 'string' && !(typeof value === 'number' && Number.isFinite(value)))
    error('FIELD_VALUE', 'value is required and must be a string or number.', `${path}.value`);
  if (field.label !== undefined && typeof field.label !== 'string')
    error('FIELD_TYPE', 'label must be a string.', `${path}.label`);
  if (field.attributedValue !== undefined)
    checkAttributedValue(ctx, field.attributedValue, `${path}.attributedValue`);

  if (field.changeMessage !== undefined) {
    if (typeof field.changeMessage !== 'string' || !field.changeMessage.includes('%@'))
      error('CHANGE_MESSAGE', 'changeMessage must contain %@.', `${path}.changeMessage`);
    if (field.attributedValue !== undefined)
      warn(
        'CHANGE_MESSAGE',
        'changeMessage on a field with attributedValue shows raw markup.',
        path,
      );
  }

  const dateKeys = ['dateStyle', 'timeStyle', 'isRelative', 'ignoresTimeZone'].filter(
    (k) => field[k] !== undefined,
  );
  if (dateKeys.length) {
    if (parseIsoDate(value) === undefined) {
      if (typeof value === 'string' && /^\d{4}-\d{2}-\d{2}/.test(value))
        error(
          'FIELD_DATE',
          'Date values need ISO 8601 with hours, minutes and a time zone.',
          `${path}.value`,
        );
      else warn('FIELD_DATE_KEYS', `${dateKeys.join(', ')} only apply to date values.`, path);
    }
    if ((field.dateStyle === undefined) !== (field.timeStyle === undefined))
      warn('FIELD_DATE_STYLE', 'Set both dateStyle and timeStyle, or neither.', path);
  }
  for (const key of ['dateStyle', 'timeStyle'])
    if (field[key] !== undefined && !inEnum(DATE_STYLES, field[key]))
      error('FIELD_ENUM', `Unknown ${key}.`, `${path}.${key}`);
  for (const key of ['isRelative', 'ignoresTimeZone'])
    if (field[key] !== undefined && typeof field[key] !== 'boolean')
      error('FIELD_TYPE', `${key} must be a boolean.`, `${path}.${key}`);

  if (field.numberStyle !== undefined && !inEnum(NUMBER_STYLES, field.numberStyle))
    error('FIELD_ENUM', 'Unknown numberStyle.', `${path}.numberStyle`);
  if (
    field.currencyCode !== undefined &&
    !(typeof field.currencyCode === 'string' && /^[A-Z]{3}$/.test(field.currencyCode))
  )
    error('FIELD_ENUM', 'currencyCode must be an ISO 4217 code.', `${path}.currencyCode`);
  if (field.numberStyle !== undefined && field.currencyCode !== undefined)
    warn('FIELD_NUMBER_FORMAT', 'Use numberStyle or currencyCode, not both.', path);
  if (
    (field.numberStyle !== undefined || field.currencyCode !== undefined) &&
    typeof value !== 'number'
  )
    warn('FIELD_NUMBER_FORMAT', 'numberStyle and currencyCode only apply to number values.', path);

  if (field.textAlignment !== undefined) {
    if (!inEnum(TEXT_ALIGNMENTS, field.textAlignment))
      error('FIELD_ENUM', 'Unknown textAlignment.', `${path}.textAlignment`);
    else if (group === 'primaryFields' || group === 'backFields')
      warn(
        'FIELD_TEXT_ALIGNMENT',
        'textAlignment is not allowed on primary and back fields.',
        `${path}.textAlignment`,
      );
  }
  if (field.dataDetectorTypes !== undefined) {
    const types = field.dataDetectorTypes;
    if (!Array.isArray(types) || !types.every((t) => inEnum(DATA_DETECTOR_TYPES, t)))
      error('FIELD_ENUM', 'Unknown dataDetectorTypes.', `${path}.dataDetectorTypes`);
    if (group !== 'backFields')
      warn(
        'FIELD_DATA_DETECTORS',
        'dataDetectorTypes only applies to back fields.',
        `${path}.dataDetectorTypes`,
      );
  }
  if (field.row !== undefined) {
    if (field.row !== 0 && field.row !== 1)
      error('FIELD_ROW', 'row must be 0 or 1.', `${path}.row`);
    else if (!(style === 'eventTicket' && group === 'auxiliaryFields'))
      warn('FIELD_ROW', 'row applies to eventTicket auxiliaryFields only.', `${path}.row`);
  }
  validateSemantics(ctx, field.semantics, `${path}.semantics`);
}

/** Style dictionary: groups, counts, field keys (unique within the dictionary), transitType. */
export function validateStyleDict(ctx: ValidationContext, style: PassStyle): void {
  const dict = ctx.pass[style] as Record<string, unknown>;
  const seen = new Set<string>();
  for (const key of Object.keys(dict))
    if (!STYLE_DICT_KEYS.has(key) && key !== '_id')
      ctx.warn('UNKNOWN_KEY', `Unknown key ${key}.`, `${style}.${key}`);
  if (style === 'boardingPass') {
    if (!inEnum(TRANSIT_TYPES, dict.transitType))
      ctx.error('TRANSIT_TYPE', 'boardingPass needs a valid transitType.', `${style}.transitType`);
  } else if (dict.transitType !== undefined) {
    ctx.warn('TRANSIT_TYPE', 'transitType applies to boardingPass only.', `${style}.transitType`);
  }

  for (const group of FIELD_GROUPS) {
    const fields = dict[group];
    if (fields === undefined) continue;
    const path = `${style}.${group}`;
    if (!Array.isArray(fields)) {
      ctx.error('FIELDS', `${group} must be an array.`, path);
      continue;
    }
    if (group === 'footerFields' && style !== 'posterGeneric')
      ctx.warn('FIELD_GROUP_STYLE', 'footerFields applies to posterGeneric only.', path);
    if (group === 'additionalInfoFields' && style !== 'eventTicket' && style !== 'posterGeneric')
      ctx.warn(
        'FIELD_GROUP_STYLE',
        'additionalInfoFields applies to event tickets and posterGeneric.',
        path,
      );
    fields.forEach((field, i) => {
      validateField(ctx, field, group, style, `${path}.${i}`);
      const key = isObject(field) ? field.key : undefined;
      if (typeof key !== 'string' || key === '') return;
      // Apple's own samples repeat keys between posterGeneric and its legacy fallback; only one renders.
      if (seen.has(key))
        ctx.error(
          'DUPLICATE_FIELD_KEY',
          `Field key ${key} is used more than once.`,
          `${path}.${i}`,
        );
      seen.add(key);
    });
  }
  validateFieldCounts(ctx, style, dict);
}
