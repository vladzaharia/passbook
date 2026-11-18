import { z } from 'zod';
import { IdSchema } from './common.ts';
import { ScanStaffSignInSchema } from './scan-session.ts';

/**
 * `POST /scan/role`: a paired phone flips between Scanner and Customer screen (stations S9).
 * The server holds the role; this body only asks for a change.
 */
export const ScanRoleChangeSchema = z.discriminatedUnion('role', [
  z.strictObject({ role: z.literal('customer') }),
  /** `unlock` is a staff PIN, required when the org has active staff. */
  z.strictObject({ role: z.literal('scan'), unlock: ScanStaffSignInSchema.optional() }),
]);
export type ScanRoleChange = z.infer<typeof ScanRoleChangeSchema>;

/** `GET /scan/role/staff?q=`: names only, to pick who is unlocking. */
export const ScanRoleStaffSchema = z.object({
  items: z.array(z.object({ id: IdSchema, name: z.string() })).max(8),
});
