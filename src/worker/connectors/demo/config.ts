import { z } from 'zod';
import { DEMO_LOCALES } from '../../../generated/demo-words.ts';

export const DATASETS = [
  'classic',
  'gym-members',
  'event-tickets',
  'hotel-stays',
  'bookings',
  'boarding-passes',
  'loyalty-cards',
  'staff-badges',
  'transit-tickets',
] as const;
export type DatasetId = (typeof DATASETS)[number];

export const FAILS = [
  'none',
  'auth',
  'forbidden',
  'timeout',
  'upstream',
  'rate_limited',
  'page_two',
  'bad_records',
] as const;

/** Used when a config has no anchor, so records never depend on today's date. */
export const DEFAULT_ANCHOR = '2026-01-05';

const RESERVED_HOSTS = ['example.com', 'example.net', 'example.org'];
const RESERVED_TLDS = ['test', 'example', 'invalid'];

/** RFC 2606 names: nothing generated under them can reach a real inbox. */
export function isReservedDomain(domain: string): boolean {
  const host = domain.trim().toLowerCase();
  if (!/^[a-z0-9.-]+$/.test(host)) return false;
  if (RESERVED_HOSTS.some((r) => host === r || host.endsWith(`.${r}`))) return true;
  const tld = host.split('.').pop() ?? '';
  return RESERVED_TLDS.includes(tld);
}

function validDate(text: string): boolean {
  const ms = Date.parse(`${text}T00:00:00Z`);
  return Number.isFinite(ms) && new Date(ms).toISOString().startsWith(text);
}

export const config = z
  .object({
    dataset: z
      .enum(DATASETS)
      .default('classic')
      .meta({
        'x-label': 'Dataset',
        'x-order': 1,
        'x-enumLabels': {
          classic: 'Classic',
          'gym-members': 'Gym members',
          'event-tickets': 'Event tickets',
          'hotel-stays': 'Hotel stays',
          bookings: 'Bookings',
          'boarding-passes': 'Boarding passes',
          'loyalty-cards': 'Loyalty cards',
          'staff-badges': 'Staff badges',
          'transit-tickets': 'Transit tickets',
        },
      }),
    /** Upstream holds <prefix>-001 .. <prefix>-<count>. */
    count: z
      .number()
      .int()
      .min(0)
      .max(1000)
      .default(25)
      .meta({ 'x-label': 'Records', 'x-help': 'Up to 1,000.', 'x-order': 2 }),
    seed: z
      .string()
      .max(60)
      .default('demo')
      .meta({ 'x-label': 'Seed', 'x-help': 'Same seed, same records.', 'x-order': 3 }),
    locale: z.enum(DEMO_LOCALES).default('en-US').meta({ 'x-label': 'Locale', 'x-order': 4 }),
    /** YYYY-MM-DD. Dates are relative to it, never to today. Filled at create. */
    anchor: z
      .string()
      .regex(/^\d{4}-\d{2}-\d{2}$/)
      .refine(validDate, 'Not a date.')
      .optional()
      .meta({ 'x-label': 'Anchor date', 'x-placeholder': 'YYYY-MM-DD', 'x-order': 5 }),
    /** Raise to simulate upstream changes. */
    revision: z
      .number()
      .int()
      .min(0)
      .max(10_000)
      .default(0)
      .meta({ 'x-label': 'Revision', 'x-help': 'Raise it to change records.', 'x-order': 6 }),
    changeRate: z.number().int().min(0).max(100).default(20).meta({
      'x-label': 'Change rate (%)',
      'x-help': 'Share of records changed per revision.',
      'x-order': 7,
    }),
    holderDomain: z
      .string()
      .max(100)
      .default('example.com')
      .meta({ 'x-label': 'Holder domain', 'x-placeholder': 'example.com', 'x-order': 8 }),
    /** Refs the upstream reports as deleted / not found. */
    missing: z
      .array(z.string().max(60))
      .max(100)
      .default([])
      .meta({ 'x-label': 'Missing records', 'x-help': 'Refs such as m-004.', 'x-order': 9 }),
    fail: z
      .enum(FAILS)
      .default('none')
      .meta({
        'x-order': 10,
        'x-label': 'Simulated failure',
        'x-help':
          'Second page fails needs more than 50 records (10 for Classic); Invalid records needs 20.',
        'x-enumLabels': {
          none: 'None',
          auth: 'Auth rejected',
          forbidden: 'Forbidden',
          timeout: 'Timeout',
          upstream: 'Upstream error',
          rate_limited: 'Rate limited',
          page_two: 'Second page fails',
          bad_records: 'Invalid records',
        },
      }),
  })
  .superRefine((c, ctx) => {
    const page = c.dataset === 'classic' ? 10 : 50;
    if (c.fail === 'page_two' && c.count <= page) {
      ctx.addIssue({
        code: 'custom',
        path: ['fail'],
        message: `Second page fails needs more than ${page} records.`,
      });
    }
    if (c.fail === 'bad_records' && c.count < 20) {
      ctx.addIssue({
        code: 'custom',
        path: ['fail'],
        message: 'Invalid records needs at least 20 records.',
      });
    }
    if (c.dataset !== 'classic' && !isReservedDomain(c.holderDomain)) {
      ctx.addIssue({
        code: 'custom',
        path: ['holderDomain'],
        message: 'Use example.com, example.net, example.org or a .test, .example or .invalid name.',
      });
    }
  });
export type Config = z.infer<typeof config>;
