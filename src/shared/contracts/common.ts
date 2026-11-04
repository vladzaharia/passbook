import { z } from 'zod';

export const IdSchema = z.string().min(1).max(64);
export const OrgIdSchema = IdSchema;
export const EmailSchema = z
  .string()
  .max(254)
  .transform((value) => value.trim().toLowerCase().normalize('NFC'))
  .pipe(z.email());
// biome-ignore lint/suspicious/noControlCharactersInRegex: rejecting control characters is the point
const NOT_PLAIN = /[\u0000-\u001f\u007f-\u009f\u2028\u2029\u202a-\u202e\u2066-\u2069]/u;
/** One line of display text that may reach a mail header: no controls, line separators or bidi marks. */
export const PlainLineSchema = (max: number) =>
  z
    .string()
    .trim()
    .normalize()
    .min(1)
    .max(max)
    .refine((value) => !NOT_PLAIN.test(value), 'Use plain text on one line.');
/** Milliseconds since the epoch. */
export const TimestampSchema = z.number().int().nonnegative();
/** Any JSON value. Not recursive on purpose: recursive schemas break OpenAPI generation. */
export const JsonSchema = z.any() as z.ZodType<Json>;
export type Json = string | number | boolean | null | Json[] | { [key: string]: Json };

export const ProblemSchema = z.object({
  type: z.string(),
  title: z.string(),
  status: z.number().int(),
  code: z.string(),
  detail: z.string(),
  requestId: z.string().optional(),
  issues: z
    .array(z.object({ path: z.string(), message: z.string(), code: z.string().optional() }))
    .optional(),
});
export type ProblemDto = z.infer<typeof ProblemSchema>;

export const PageQuerySchema = z.object({
  cursor: z.string().max(512).optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
});

export function pageOf<T extends z.ZodType>(item: T) {
  return z.object({ items: z.array(item), nextCursor: z.string().nullable() });
}

export const IdParamSchema = z.object({ id: IdSchema });
export const OkSchema = z.object({ ok: z.literal(true) });

export const ApiScopeSchema = z.enum([
  'passes:read',
  'passes:write',
  'holders:write',
  'templates:read',
]);
export const RoleSchema = z.enum(['admin', 'user']);

/** Sandbox: test passes, keys and events never mix with live ones in lists or metrics. */
export const ModeSchema = z.enum(['live', 'test']);
export type Mode = z.infer<typeof ModeSchema>;
/** Admin sessions pick a mode with this header; anything but `test` means live. */
export const MODE_HEADER = 'x-passbook-mode';
