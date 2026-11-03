import { z } from 'zod';
import { EmailSchema, IdSchema, RoleSchema, TimestampSchema } from './common.ts';

export const SessionUserSchema = z.object({
  id: IdSchema,
  name: z.string().nullable(),
  primaryEmail: z.string(),
});

export const SessionResponseSchema = z.discriminatedUnion('authenticated', [
  z.object({
    authenticated: z.literal(true),
    user: SessionUserSchema,
    roles: z.array(RoleSchema),
    csrfToken: z.string(),
    amr: z.enum(['oidc', 'magic_link', 'breakglass']),
    expiresAt: TimestampSchema,
  }),
  z.object({
    authenticated: z.literal(false),
    turnstileSiteKey: z.string(),
    oidcEnabled: z.boolean(),
    magicLinkEnabled: z.boolean(),
  }),
]);
export type SessionResponse = z.infer<typeof SessionResponseSchema>;

/** Which the sign-in email leads with. Layout only: the link and the code both work either way. */
export const MagicPreferSchema = z.enum(['link', 'code']);
export type MagicPrefer = z.infer<typeof MagicPreferSchema>;

export const MagicLinkRequestSchema = z.object({
  email: EmailSchema,
  turnstileToken: z.string().min(1).max(4096),
  next: z.string().max(512).optional(),
  /** `code` from the installed app, where a link would open the browser instead. */
  prefer: MagicPreferSchema.optional(),
});
/** Consume with the link token (confirm click) or with email + 6-digit code (same browser only). */
export const MagicLinkConsumeSchema = z.union([
  z.object({ token: z.string().min(16).max(256) }),
  z.object({ email: EmailSchema, code: z.string().regex(/^\d{6}$/) }),
]);
/** JSON answer of a consume: where to go (the shared landing rule, or /account?verified=). */
export const MagicConsumeResultSchema = z.object({ ok: z.literal(true), next: z.string() });
export const OidcStartQuerySchema = z.object({ next: z.string().max(512).optional() });
/** all=1 ends every session of the account; next is kept for the sign-in page. */
export const LogoutQuerySchema = z.object({
  all: z.enum(['1']).optional(),
  next: z.string().max(512).optional(),
});
