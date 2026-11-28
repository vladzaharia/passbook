import { z } from 'zod';
import {
  EmailSchema,
  IdSchema,
  ModeSchema,
  PageQuerySchema,
  PlainLineSchema,
  pageOf,
  TimestampSchema,
} from './common.ts';

/** Who a guest or walk-in is visiting. Not a user and not staff: no sign-in, no PIN. */
export const ScanHostSchema = z.strictObject({
  id: IdSchema,
  mode: ModeSchema,
  displayName: PlainLineSchema(60),
  email: EmailSchema,
  /** Email the host when their guest arrives (limits: kiosk-architecture §5). */
  notify: z.boolean(),
  active: z.boolean(),
  createdAt: TimestampSchema,
});
export type ScanHost = z.infer<typeof ScanHostSchema>;
export const ScanHostCreateSchema = z.strictObject({
  displayName: PlainLineSchema(60),
  email: EmailSchema,
  notify: z.boolean().default(true),
});
export const ScanHostPatchSchema = ScanHostCreateSchema.partial().extend({
  active: z.boolean().optional(),
});
export const ScanHostQuerySchema = PageQuerySchema.extend({
  q: z.string().trim().max(60).optional(),
});
export const ScanHostListSchema = pageOf(ScanHostSchema);

/** `GET /scan/kiosk/hosts?q=`: the kiosk sees the id and the name, never the email. */
export const KioskHostQuerySchema = z.strictObject({ q: z.string().trim().min(2).max(40) });
export const KioskHostSchema = z.strictObject({ id: IdSchema, displayName: PlainLineSchema(60) });
export const KioskHostResultSchema = z.strictObject({ items: z.array(KioskHostSchema).max(5) });
