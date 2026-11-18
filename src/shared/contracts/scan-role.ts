import { z } from 'zod';

/**
 * `POST /scan/role`: a paired phone flips between Scanner and Customer screen (stations S9).
 * The server holds the role; this body only asks for a change.
 */
export const ScanRoleChangeSchema = z.discriminatedUnion('role', [
  z.strictObject({ role: z.literal('customer') }),
  /** `unlock` is a staff PIN with no name, required when the org has active staff. */
  z.strictObject({
    role: z.literal('scan'),
    unlock: z.strictObject({ pin: z.string().regex(/^\d{6}$/) }).optional(),
  }),
]);
export type ScanRoleChange = z.infer<typeof ScanRoleChangeSchema>;
