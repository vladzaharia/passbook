/**
 * The Who's in calls, as the scanner client assumes them (WP-J). WP-G serves `GET /scan/live/inside`
 * and `POST /scan/mark-out` for Desk-role scanners. When WP-G's contracts land in `shared/contracts`,
 * these schemas become re-exports. The row is `ScanInsideRowSchema` plus the zone with its parent,
 * the due time and, for visitors, the host.
 */
import { z } from 'zod';
import { TimestampSchema } from '../../../shared/contracts/common.ts';
import {
  type PlaceKeySchema,
  ScanInsideRowSchema,
  ScanMarkOutRequestSchema,
  ScanPlaceRevSchema,
} from '../../../shared/contracts/scan-occupancy.ts';

export const InsideRowSchema = ScanInsideRowSchema.extend({
  /** The pass's zone, with its parent's name when it has one ("Floor 3 · in HQ"). */
  zone: z.object({ name: z.string(), parent: z.string().nullable() }),
  /** When max stay or clear-at will tap them out. Null: never. */
  dueAt: TimestampSchema.nullable(),
  /** A visitor's host. */
  host: z.string().nullable().default(null),
});
export type InsideRow = z.infer<typeof InsideRowSchema>;

/** `places`: every tracked place the session checks, each with its count and `rev`. */
export const InsideListSchema = z.object({
  places: z
    .array(ScanPlaceRevSchema.extend({ parent: z.string().nullable().default(null) }))
    .max(8),
  items: z.array(InsideRowSchema).max(100),
  /** Rows that match `place` and `q`. */
  total: z.number().int().min(0),
  nextCursor: z.string().nullable(),
  asOf: TimestampSchema,
});
export type InsideList = z.infer<typeof InsideListSchema>;
export type InsidePlace = InsideList['places'][number];

/** Query of `GET /scan/live/inside`. No `place`: every place of the session. Sorted longest first. */
export interface InsideQuery {
  place?: z.infer<typeof PlaceKeySchema>;
  /** A name filter, 1 to 120 characters. */
  q?: string;
  cursor?: string;
  limit?: number;
}

export { ScanMarkOutRequestSchema as MarkOutRequestSchema };
export type MarkOutRequest = z.infer<typeof ScanMarkOutRequestSchema>;

/** `POST /scan/mark-out`. `scanId` is the exit row; `POST /scans/:id/undo` takes it back. */
export const MarkOutResultSchema = z.object({
  scanId: z.string(),
  place: ScanPlaceRevSchema,
  undoUntil: TimestampSchema.nullable(),
});
export type MarkOutResult = z.infer<typeof MarkOutResultSchema>;

/** What the list needs from outside. The real one is `ScanApi`; tests use `fakeInsideApi`. */
export interface InsideApiPort {
  inside(query: InsideQuery, call: { signal?: AbortSignal }): Promise<InsideList>;
  markOut(body: MarkOutRequest, call?: { signal?: AbortSignal }): Promise<MarkOutResult>;
  undoMarkOut(scanId: string, idempotencyKey: string): Promise<unknown>;
}
