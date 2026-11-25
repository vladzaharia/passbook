import { z } from 'zod';
import { ACCESS_COPY } from '../copy/access.ts';
import { strictEmail } from '../email.ts';

/** The site's Request access form: one mail to PassBook's inbox. Not part of the public API. */

export const ACCESS_PURPOSES = [
  'Memberships',
  'Events and tickets',
  'Loyalty and stamps',
  'Visitors and staff',
  'Something else',
] as const;

export const ACCESS_NAME_MAX = 120;
export const ACCESS_ORG_MAX = 160;
export const ACCESS_MESSAGE_MAX = 600;
export const ACCESS_FORM_MAX_BYTES = 4096;

/** Controls and invisible formatting (bidi overrides, zero-width marks) never belong in a name or organization. */
const HIDDEN = /[\p{Cc}\p{Cf}]/u;
/** A message may break lines and indent, nothing else invisible. */
const HIDDEN_IN_MESSAGE = /[\p{Cf}\p{Cc}]/u;

/** A browser posts a textarea's line breaks as CRLF; count and store them as one character. */
const lines = (value: string) => value.replace(/\r\n?/g, '\n');

const oneLine = (max: number, message: string) =>
  z
    .string({ error: message })
    // Before the spaces collapse: a line break or tab inside the value is refused, not flattened.
    .refine((value) => !HIDDEN.test(value), message)
    .transform((value) => value.normalize('NFC').replace(/\s+/gu, ' ').trim())
    .pipe(z.string().min(1, message).max(max, message));

export const AccessRequestSchema = z.object({
  name: oneLine(ACCESS_NAME_MAX, ACCESS_COPY.name),
  email: z.string({ error: ACCESS_COPY.email }).transform((value, ctx) => {
    const email = strictEmail(value);
    if (email === null) ctx.addIssue({ code: 'custom', message: ACCESS_COPY.email });
    return email ?? '';
  }),
  org: oneLine(ACCESS_ORG_MAX, ACCESS_COPY.org),
  purpose: z.enum(ACCESS_PURPOSES, { error: ACCESS_COPY.purpose }),
  message: z
    .string()
    .optional()
    .transform((value) => lines(value ?? '').trim())
    .pipe(
      z
        .string()
        .max(ACCESS_MESSAGE_MAX, ACCESS_COPY.message)
        .refine(
          (value) => !HIDDEN_IN_MESSAGE.test(value.replace(/[\n\t]/g, '')),
          ACCESS_COPY.message,
        ),
    ),
});

export type AccessRequest = z.infer<typeof AccessRequestSchema>;
