import { z } from 'zod';
import { TimestampSchema } from './common.ts';

/** 6 Crockford base32 characters, as printed on a guest pass. */
export const GUEST_CODE_LENGTH = 6;
export const GuestCodeSchema = z
  .string()
  .regex(/^[0-9A-HJKMNP-TV-Z]{6}$/, 'Enter the 6-character code.');
/** What a guest types: any case, spaces or hyphens, and the look-alikes I, L and O. */
export function normalizeGuestCode(raw: string): string {
  return raw.toUpperCase().replace(/[\s-]/g, '').replace(/[IL]/g, '1').replace(/O/g, '0');
}
export const GuestCodeInputSchema = z
  .string()
  .max(24)
  .transform(normalizeGuestCode)
  .pipe(GuestCodeSchema);
/** `POST /passes/{id}/guest-code`: a new code replaces the old one. Shown once, never stored in clear. */
export const GuestCodeRotatedSchema = z.strictObject({
  code: GuestCodeSchema,
  expiresAt: TimestampSchema,
});
export type GuestCodeRotated = z.infer<typeof GuestCodeRotatedSchema>;
