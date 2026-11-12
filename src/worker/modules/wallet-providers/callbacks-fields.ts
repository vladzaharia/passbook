import { BadRequestError } from '../../platform/errors.ts';
import type { SamsungCardProjection } from './samsung.ts';

const invalid = () =>
  new BadRequestError('Invalid Samsung Wallet fields.', 'SAMSUNG_FIELDS_INVALID');

/** An unsigned selector may narrow an approved card, never add data or alter state. */
export function samsungRequestedFields(url: URL): string[] | null {
  if (url.search.length > 512) throw invalid();
  const entries = [...url.searchParams.entries()];
  if (entries.some(([key]) => key !== 'fields') || entries.length > 1) throw invalid();
  if (!entries.length) return null;
  const value = entries[0]?.[1] ?? '';
  if (value.length > 128 || !/^[A-Za-z0-9_.]+(?:,[A-Za-z0-9_.]+)*$/.test(value)) throw invalid();
  const fields = value.split(',');
  if (new Set(fields).size !== fields.length) throw invalid();
  return fields;
}

export function filterSamsungCardFields(
  projection: SamsungCardProjection,
  fields: string[] | null,
): SamsungCardProjection {
  if (!fields) return projection;
  const item = projection.card.data[0];
  if (
    !item ||
    projection.card.data.length !== 1 ||
    fields.some((field) => !Object.hasOwn(item.attributes, field))
  )
    throw invalid();
  return {
    card: {
      ...projection.card,
      data: [
        {
          ...item,
          attributes: Object.fromEntries(fields.map((field) => [field, item.attributes[field]])),
        },
      ],
    },
  };
}

/** cc2 is unsigned; it is only a two-letter fixed-host routing hint. */
export function samsungCountryHint(url: URL): string | null {
  if (url.search.length > 512) throw new BadRequestError();
  const values = url.searchParams.getAll('cc2');
  const value = values.length === 1 ? values[0] : undefined;
  return value && /^[A-Za-z]{2}$/.test(value) ? value.toUpperCase() : null;
}
