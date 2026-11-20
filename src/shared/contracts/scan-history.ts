import { z } from 'zod';
import { IdSchema, PlainLineSchema, TimestampSchema } from './common.ts';
import { ScanReasonSchema } from './scan.ts';

/** How far back a person's history reads. */
export const HISTORY_DAYS = 30;
/** Notes one pass keeps. */
export const PASS_NOTE_CAP = 100;
/** Notes one device may add to one pass in a day. */
export const NOTE_DEVICE_CAP = 10;
export const NOTE_MAX = 280;
/** One plain line, capped: the only text a staff note may carry. */
export const NoteSchema = PlainLineSchema(NOTE_MAX);

export const HistoryFilterSchema = z.enum(['all', 'visits', 'changes']);
export type HistoryFilter = z.infer<typeof HistoryFilterSchema>;

/** `GET /scan/passes/{id}/history`. `cursor` is the previous page's `nextCursor`. */
export const HistoryQuerySchema = z.object({
  filter: HistoryFilterSchema.default('all'),
  cursor: z
    .string()
    .regex(/^\d{1,15}_[A-Za-z0-9_-]{1,64}$/)
    .optional(),
  limit: z.coerce.number().int().min(1).max(50).default(20),
});

export const HistoryEventSchema = z.enum([
  'scanned',
  'checked_in',
  'checked_out',
  'refused',
  'held',
  'let_in',
  'undone',
  'value',
  'note',
]);
export type HistoryEvent = z.infer<typeof HistoryEventSchema>;

/**
 * One line of a person's history. Every field past `event` is as the viewer's role may see it: a
 * Door sees no staff, values or notes, and a line the signed policy does not vouch for shows its
 * time and result alone.
 */
export const HistoryItemSchema = z.object({
  id: IdSchema,
  at: TimestampSchema,
  event: HistoryEventSchema,
  reason: ScanReasonSchema.nullable(),
  /** The action as the pass type names it (Check in, Add stamp). */
  label: z.string().nullable(),
  /** The device that took it. */
  place: z.string().nullable(),
  /** Who: the staff member, or the author of a note. Desk and above. */
  staff: z.string().nullable(),
  /** The change a value action made. Desk and above. */
  amount: z.number().nullable(),
});
export type HistoryItem = z.infer<typeof HistoryItemSchema>;

export const HistoryPageSchema = z.object({
  items: z.array(HistoryItemSchema).max(50),
  nextCursor: z.string().nullable(),
});
export type HistoryPage = z.infer<typeof HistoryPageSchema>;

/** `POST /scan/passes/{id}/notes`. The key makes a retried tap one note. */
export const PassNoteRequestSchema = z.strictObject({
  body: NoteSchema,
  idempotencyKey: IdSchema,
});

/** `PATCH /scan/passes/{id}/notes/{noteId}`. */
export const PassNoteEditSchema = z.strictObject({ body: NoteSchema });

export const PassNoteSchema = z.object({
  id: IdSchema,
  at: TimestampSchema,
  body: z.string().max(NOTE_MAX),
  by: z.string().max(120),
  /** Written by the viewer: they may change it. A Manager may change any. */
  own: z.boolean(),
  edited: z.boolean(),
});
export type PassNote = z.infer<typeof PassNoteSchema>;

/** `GET /scan/passes/{id}/notes`: newest first. Desk and above; a Door has none. */
export const PassNotesSchema = z.object({ items: z.array(PassNoteSchema).max(PASS_NOTE_CAP) });
export type PassNotes = z.infer<typeof PassNotesSchema>;
