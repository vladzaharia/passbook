/**
 * The Who's in calls, as WP-G serves them (`wpg-api.md`: `GET /scan/live/inside`, `POST
 * /scan/mark-out`). The wire shapes are mirrored here until `shared/contracts/scan-whos-in.ts` is
 * on main; then `InsideWireSchema` becomes a re-export. The list reads as `InsideList`: a row has
 * its zone with the parent's name, and the header carries each place's count and `rev`.
 */
import { z } from 'zod';
import { TimestampSchema } from '../../../shared/contracts/common.ts';
import { ScanOutcomeSchema } from '../../../shared/contracts/scan.ts';
import {
  PlaceKeySchema,
  ScanMarkOutRequestSchema,
  ScanPlaceRevSchema,
} from '../../../shared/contracts/scan-occupancy.ts';

const WireRowSchema = z.object({
  passId: z.string(),
  holder: z.string().nullable(),
  photoUrl: z.string().nullable(),
  plan: z.string().nullable(),
  place: PlaceKeySchema,
  placeName: z.string(),
  parentName: z.string().nullable(),
  since: TimestampSchema,
  /** When max stay or clear-at will tap them out. Null: never. */
  dueAt: TimestampSchema.nullable(),
  via: z.string().nullable(),
  flags: z.array(z.enum(['long_stay', 'pass_ended'])).max(2),
  /** Not served yet: a visitor's host. The row shows it when it is there. */
  host: z.string().nullable().optional(),
});

/** `GET /scan/live/inside` as the server sends it. */
export const InsideWireSchema = z.object({
  /** Longest inside first, at most 100. */
  items: z.array(WireRowSchema).max(100),
  /** Everyone inside the requested places now, whatever `q` says. */
  count: z.number().int().min(0),
  /** The highest place revision in scope. */
  rev: z.number().int().min(0),
  places: z.array(ScanPlaceRevSchema).max(8),
  nextCursor: z.string().nullable(),
});
export type InsideWire = z.infer<typeof InsideWireSchema>;

export interface InsideRow {
  passId: string;
  holder: string | null;
  photoUrl: string | null;
  plan: string | null;
  place: string;
  since: number;
  via: string | null;
  flags: ('long_stay' | 'pass_ended')[];
  zone: { name: string; parent: string | null };
  dueAt: number | null;
  host: string | null;
}
export type InsidePlace = z.infer<typeof ScanPlaceRevSchema>;
export interface InsideList {
  places: InsidePlace[];
  items: InsideRow[];
  /** Everyone inside the requested places. */
  total: number;
  nextCursor: string | null;
  /** When the client read it. */
  asOf: number;
}

export const toInsideList = (wire: InsideWire, asOf: number): InsideList => ({
  places: wire.places,
  items: wire.items.map(({ placeName, parentName, host, ...row }) => ({
    ...row,
    zone: { name: placeName, parent: parentName },
    host: host ?? null,
  })),
  total: wire.count,
  nextCursor: wire.nextCursor,
  asOf,
});

/** The list as the app reads it: parsed and mapped in one step. */
export const InsideListSchema = InsideWireSchema.transform((wire) =>
  toInsideList(wire, Date.now()),
);

/** Query of `GET /scan/live/inside`. No `place`: every place of the session. `q` is at most 80 characters. */
export interface InsideQuery {
  place?: z.infer<typeof PlaceKeySchema>;
  q?: string;
  cursor?: string;
  /** 1 to 100, default 50. */
  limit?: number;
}

export const INSIDE_Q_MAX = 80;

export {
  ScanMarkOutRequestSchema as MarkOutRequestSchema,
  ScanOutcomeSchema as MarkOutResultSchema,
};
export type MarkOutRequest = z.infer<typeof ScanMarkOutRequestSchema>;
export type MarkOutResult = z.infer<typeof ScanOutcomeSchema>;

/** What the list needs from outside. The real one is `ScanApi`; tests use `fakeInsideApi`. */
export interface InsideApiPort {
  inside(query: InsideQuery, call: { signal?: AbortSignal }): Promise<InsideList>;
  /** An `ok` outcome: `scanId` is the exit, `counts.place` the new count. 409 `NOT_INSIDE` when already out. */
  markOut(body: MarkOutRequest, call?: { signal?: AbortSignal }): Promise<MarkOutResult>;
  /** The ordinary undo route takes the exit back. */
  undoMarkOut(scanId: string, idempotencyKey: string): Promise<unknown>;
}
