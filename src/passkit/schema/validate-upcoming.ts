import { EVENT_URL_KEYS, MAX_REMOTE_IMAGE_BYTES } from './constants.ts';
import {
  checkUrlValue,
  isFiniteNumber,
  isObject,
  parseIsoDate,
  type ValidationContext,
} from './util.ts';
import { validateField } from './validate-fields.ts';
import { validateSemantics } from './validate-semantics.ts';

const ENTRY_KEYS = [
  'identifier',
  'name',
  'type',
  'dateInformation',
  'isActive',
  'semantics',
  'additionalInfoFields',
  'backFields',
  'URLs',
  'images',
  'auxiliaryStoreIdentifiers',
];
const DATE_INFO_KEYS = [
  'date',
  'ignoreTimeComponents',
  'isAllDay',
  'isUnannounced',
  'isUndetermined',
  'timeZone',
];

function checkImage(ctx: ValidationContext, image: unknown, path: string): void {
  const { error, warn } = ctx;
  if (!isObject(image)) {
    error('UPCOMING', 'Image must be an object.', path);
    return;
  }
  for (const key of Object.keys(image))
    if (!['URLs', 'reuseExisting', '_id'].includes(key))
      warn('UNKNOWN_KEY', `Unknown key ${key}.`, `${path}.${key}`);
  if (image.reuseExisting !== undefined && typeof image.reuseExisting !== 'boolean')
    error('UPCOMING', 'reuseExisting must be a boolean.', `${path}.reuseExisting`);
  if (image.URLs === undefined) return;
  if (!Array.isArray(image.URLs)) {
    error('UPCOMING', 'URLs must be an array.', `${path}.URLs`);
    return;
  }
  image.URLs.forEach((entry: unknown, i) => {
    const p = `${path}.URLs.${i}`;
    if (!isObject(entry)) {
      error('UPCOMING', 'Image URL must be an object.', p);
      return;
    }
    for (const key of Object.keys(entry))
      if (!['URL', 'SHA256', 'scale', 'size', '_id'].includes(key))
        warn('UNKNOWN_KEY', `Unknown key ${key}.`, `${p}.${key}`);
    let url: URL | undefined;
    try {
      url = new URL(String(entry.URL));
    } catch {
      url = undefined;
    }
    if (url?.protocol !== 'https:') error('UPCOMING', 'Image URL must be https.', `${p}.URL`);
    if (typeof entry.SHA256 !== 'string' || !/^[0-9a-fA-F]{64}$/.test(entry.SHA256))
      error('UPCOMING', 'SHA256 must be a 64-character hex digest.', `${p}.SHA256`);
    if (entry.scale !== undefined && ![1, 2, 3].includes(entry.scale as number))
      error('UPCOMING', 'scale must be 1, 2 or 3.', `${p}.scale`);
    if (
      !isFiniteNumber(entry.size) ||
      !Number.isInteger(entry.size) ||
      entry.size <= 0 ||
      entry.size > MAX_REMOTE_IMAGE_BYTES
    )
      error('UPCOMING', 'size must be a byte count of at most 2 MB.', `${p}.size`);
  });
}

function checkEntry(ctx: ValidationContext, entry: unknown, path: string, ids: Set<string>): void {
  const { error, warn } = ctx;
  if (!isObject(entry)) {
    error('UPCOMING', 'Entry must be an object.', path);
    return;
  }
  for (const key of Object.keys(entry))
    if (!ENTRY_KEYS.includes(key) && key !== '_id')
      warn('UNKNOWN_KEY', `Unknown key ${key}.`, `${path}.${key}`);
  if (typeof entry.identifier !== 'string' || entry.identifier === '' || ids.has(entry.identifier))
    error('UPCOMING', 'Entries need unique identifiers.', `${path}.identifier`);
  else ids.add(entry.identifier);
  if (typeof entry.name !== 'string' || entry.name === '')
    error('UPCOMING', 'name is required.', `${path}.name`);
  if (entry.type !== 'event') error('UPCOMING', 'type must be "event".', `${path}.type`);
  if (entry.isActive !== undefined && typeof entry.isActive !== 'boolean')
    error('UPCOMING', 'isActive must be a boolean.', `${path}.isActive`);

  const info = entry.dateInformation;
  if (info !== undefined) {
    if (!isObject(info))
      error('UPCOMING', 'dateInformation must be an object.', `${path}.dateInformation`);
    else {
      for (const key of Object.keys(info))
        if (!DATE_INFO_KEYS.includes(key))
          warn('UNKNOWN_KEY', `Unknown key ${key}.`, `${path}.dateInformation.${key}`);
      if (info.date !== undefined && parseIsoDate(info.date) === undefined)
        error(
          'DATE',
          'date must be ISO 8601 with hours and minutes.',
          `${path}.dateInformation.date`,
        );
      for (const key of ['ignoreTimeComponents', 'isAllDay', 'isUnannounced', 'isUndetermined'])
        if (info[key] !== undefined && typeof info[key] !== 'boolean')
          error('UPCOMING', `${key} must be a boolean.`, `${path}.dateInformation.${key}`);
    }
  }
  validateSemantics(ctx, entry.semantics, `${path}.semantics`);

  for (const group of ['additionalInfoFields', 'backFields'] as const) {
    const fields = entry[group];
    if (fields === undefined) continue;
    if (!Array.isArray(fields)) {
      error('FIELDS', `${group} must be an array.`, `${path}.${group}`);
      continue;
    }
    const seen = new Set<string>();
    fields.forEach((field: unknown, i) => {
      validateField(ctx, field, group, 'eventTicket', `${path}.${group}.${i}`);
      const key = isObject(field) ? field.key : undefined;
      if (typeof key !== 'string') return;
      if (seen.has(key))
        error(
          'DUPLICATE_FIELD_KEY',
          `Field key ${key} is used more than once.`,
          `${path}.${group}.${i}`,
        );
      seen.add(key);
    });
  }
  if (!Array.isArray(entry.backFields) || entry.backFields.length === 0)
    warn('UPCOMING', 'The event detail view needs at least one back field.', `${path}.backFields`);

  if (entry.URLs !== undefined) {
    if (!isObject(entry.URLs)) error('UPCOMING', 'URLs must be an object.', `${path}.URLs`);
    else
      for (const [key, value] of Object.entries(entry.URLs)) {
        if (!(EVENT_URL_KEYS as readonly string[]).includes(key))
          warn('UNKNOWN_KEY', `Unknown key ${key}.`, `${path}.URLs.${key}`);
        else checkUrlValue(ctx, key, value, `${path}.URLs.${key}`);
      }
  }
  if (entry.images !== undefined) {
    if (!isObject(entry.images)) error('UPCOMING', 'images must be an object.', `${path}.images`);
    else
      for (const [key, image] of Object.entries(entry.images)) {
        if (key !== 'headerImage' && key !== 'venueMap')
          warn('UNKNOWN_KEY', `Unknown key ${key}.`, `${path}.images.${key}`);
        else checkImage(ctx, image, `${path}.images.${key}`);
      }
  }
  if (
    entry.auxiliaryStoreIdentifiers !== undefined &&
    !(
      Array.isArray(entry.auxiliaryStoreIdentifiers) &&
      entry.auxiliaryStoreIdentifiers.every(Number.isInteger)
    )
  )
    error(
      'UPCOMING',
      'auxiliaryStoreIdentifiers must be integers.',
      `${path}.auxiliaryStoreIdentifiers`,
    );
}

export function validateUpcoming(ctx: ValidationContext): void {
  const entries = ctx.pass.upcomingPassInformation;
  if (entries === undefined) return;
  if (!Array.isArray(entries)) {
    ctx.error('UPCOMING', 'upcomingPassInformation must be an array.', 'upcomingPassInformation');
    return;
  }
  if (!ctx.styles.has('PET'))
    ctx.warn(
      'STYLE_MISMATCH',
      'upcomingPassInformation applies to poster event tickets.',
      'upcomingPassInformation',
    );
  const ids = new Set<string>();
  entries.forEach((entry: unknown, i) => {
    checkEntry(ctx, entry, `upcomingPassInformation.${i}`, ids);
  });
}
