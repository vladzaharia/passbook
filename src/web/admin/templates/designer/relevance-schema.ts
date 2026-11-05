import { describeSchema, type FieldDef, flatFields } from '../../passes/schema-form/index.ts';
import type { ListKey } from './ops-more.ts';

/** The server accepts at most this many of each (validate-relevance). */
const MAX_ROWS = 10;

const num = (label: string, extra: Record<string, unknown> = {}) => ({
  type: 'number',
  'x-label': label,
  ...extra,
});

/** Row definitions for the pass's relevance lists, in the shape the schema form reads. */
const SCHEMA = {
  locations: {
    'x-label': 'Locations',
    'x-itemLabel': 'Location',
    items: {
      properties: {
        latitude: num('Latitude', { minimum: -90, maximum: 90 }),
        longitude: num('Longitude', { minimum: -180, maximum: 180 }),
        relevantText: { type: 'string', 'x-label': 'Lock screen text' },
        maxDistance: num('Distance (m)', { 'x-help': 'Can only shrink the default.' }),
      },
      required: ['latitude', 'longitude'],
    },
  },
  beacons: {
    'x-label': 'Beacons',
    'x-itemLabel': 'Beacon',
    items: {
      properties: {
        proximityUUID: {
          type: 'string',
          'x-label': 'UUID',
          pattern: '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$',
          'x-help': 'Like 3F2A9B1C-4D5E-4F60-8A7B-9C0D1E2F3A4B.',
        },
        major: num('Major', { type: 'integer', minimum: 0, maximum: 65535 }),
        minor: num('Minor', { type: 'integer', minimum: 0, maximum: 65535 }),
        relevantText: { type: 'string', 'x-label': 'Lock screen text' },
      },
      required: ['proximityUUID'],
    },
  },
  relevantDates: {
    'x-label': 'Relevant dates',
    'x-itemLabel': 'Date',
    items: {
      properties: {
        startDate: { type: 'string', format: 'date-time', 'x-label': 'Starts' },
        endDate: { type: 'string', format: 'date-time', 'x-label': 'Ends' },
      },
      required: ['startDate', 'endDate'],
    },
  },
} as const;

export function relevanceSchema(list: ListKey) {
  return {
    properties: {
      [list]: { type: 'array', maxItems: MAX_ROWS, ...SCHEMA[list] },
    },
  };
}

export function relevanceField(list: ListKey): FieldDef {
  const field = flatFields(describeSchema(relevanceSchema(list)))[0];
  if (!field) throw new Error(`No relevance schema for ${list}`);
  return field;
}
