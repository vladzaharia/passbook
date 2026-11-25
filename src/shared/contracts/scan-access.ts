import { z } from 'zod';
import { IdSchema, PageQuerySchema, PlainLineSchema, pageOf, TimestampSchema } from './common.ts';
import { TimeZoneSchema } from './scan-base.ts';
import { hasNoLimits, NEEDS_TRACKING, OccupancyFieldsSchema } from './scan-occupancy.ts';

/** What an Access card's plan says about a verdict. Null on every other template. */
export const ScanAccessSchema = z.object({
  plan: z.object({ id: z.string(), label: z.string(), kind: z.enum(['always', 'timed', 'guest']) }),
  zone: z.object({ id: IdSchema, name: z.string() }).nullable(),
  closesAt: TimestampSchema.nullable(),
  nextOpenAt: TimestampSchema.nullable(),
  visits: z.object({ used: z.number().int(), limit: z.number().int().nullable() }).nullable(),
  visit: z.boolean(),
  /** The deciding zone's clock; the client formats {time} and {when} with it. */
  timeZone: TimeZoneSchema,
});
export type ScanAccess = z.infer<typeof ScanAccessSchema>;

export const ZoneKeySchema = z.string().regex(/^[a-z0-9][a-z0-9-]{0,39}$/, 'Use a-z, 0-9 and -.');
export const WeekdaySchema = z.enum(['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun']);
/** `HH:MM-HH:MM`. An end at or before the start runs past midnight; `24:00` only as an end. */
export const HoursSpanSchema = z
  .string()
  .regex(/^([01]\d|2[0-3]):[0-5]\d-(([01]\d|2[0-3]):[0-5]\d|24:00)$/, 'Use HH:MM-HH:MM.');
export const WeeklyHoursSchema = z.partialRecord(
  WeekdaySchema,
  z.array(HoursSpanSchema).min(1).max(4),
);
export type WeeklyHours = z.infer<typeof WeeklyHoursSchema>;

/** A scanning session takes up to 8 zones; a monitor watches up to 8. */
export const ZoneIdsSchema = z
  .array(IdSchema)
  .max(8)
  .refine((ids) => new Set(ids).size === ids.length, 'Each zone once.');

const ZoneNameSchema = PlainLineSchema(40);
export const ScanZoneSchema = OccupancyFieldsSchema.extend({
  id: IdSchema,
  orgId: IdSchema,
  key: ZoneKeySchema,
  name: ZoneNameSchema,
  parentId: IdSchema.nullable(),
  /** Roots only. */
  timeZone: TimeZoneSchema.nullable(),
  effectiveTimeZone: TimeZoneSchema.nullable(),
  sort: z.number().int(),
  depth: z.number().int().min(0).max(3),
  sessions: z.number().int(),
  /** The live sessions that check this zone. */
  checkedAt: z.array(z.object({ id: IdSchema, name: z.string() })),
  plans: z.array(
    z.object({
      templateId: IdSchema,
      templateName: z.string(),
      planId: z.string(),
      label: z.string(),
    }),
  ),
  /** Who is inside now, when the zone tracks. */
  inNow: z.number().int().nullable(),
  archivedAt: TimestampSchema.nullable(),
});
export type ScanZone = z.infer<typeof ScanZoneSchema>;
export const ScanZoneListSchema = pageOf(ScanZoneSchema);
export const ScanZoneListQuerySchema = PageQuerySchema.extend({
  orgId: IdSchema.optional(),
  archived: z.enum(['true', 'false']).optional(),
});
export const CreateScanZoneSchema = OccupancyFieldsSchema.partial()
  .extend({
    orgId: IdSchema,
    key: ZoneKeySchema,
    name: ZoneNameSchema,
    parentId: IdSchema.nullable().optional(),
    timeZone: TimeZoneSchema.nullable().optional(),
    sort: z.number().int().optional(),
  })
  .strict()
  .refine(
    (s) => (s.occupancy !== undefined && s.occupancy !== 'off') || hasNoLimits(s),
    NEEDS_TRACKING,
  );
/** No defaults: a field that is absent is left as it is. */
export const UpdateScanZoneSchema = OccupancyFieldsSchema.partial()
  .extend({
    name: ZoneNameSchema.optional(),
    parentId: IdSchema.nullable().optional(),
    timeZone: TimeZoneSchema.nullable().optional(),
    sort: z.number().int().optional(),
    archived: z.boolean().optional(),
  })
  .strict()
  .refine((s) => s.occupancy !== 'off' || hasNoLimits(s), NEEDS_TRACKING);
export const SessionZonesSchema = z.strictObject({ zoneIds: ZoneIdsSchema });

/** The pass detail's Access card. */
export const PassAccessSchema = z.object({
  plan: z.object({ id: z.string(), label: z.string(), kind: z.enum(['always', 'timed', 'guest']) }),
  zones: z.array(z.object({ id: IdSchema, name: z.string() })).max(24),
  /** Any zone of the plan is open at the request time. */
  openNow: z.boolean(),
  nextOpenAt: TimestampSchema.nullable(),
  visits: z.object({ used: z.number().int(), limit: z.number().int().nullable() }).nullable(),
  lastVisitAt: TimestampSchema.nullable(),
  suspended: z.boolean(),
});
export type PassAccess = z.infer<typeof PassAccessSchema>;

/** A guest's visit count was cleared: the next grant starts again at one. */
export const ScanVisitsResetSchema = z.object({ passId: IdSchema, visits: z.literal(0) });
export type ScanVisitsReset = z.infer<typeof ScanVisitsResetSchema>;

/** Devices one scanning session holds; a screen can follow all of them. */
export const SESSION_DEVICE_CAP = 64;
