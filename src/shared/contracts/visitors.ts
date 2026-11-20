import { z } from 'zod';
import { EmailSchema, IdSchema, PlainLineSchema, pageOf, TimestampSchema } from './common.ts';

export const VISITOR_STATUSES = ['expected', 'in', 'out', 'no_show', 'cancelled'] as const;
export const VisitorStatusSchema = z.enum(VISITOR_STATUSES);
export type VisitorStatus = z.infer<typeof VisitorStatusSchema>;

export const VISITOR_TABS = ['today', 'upcoming', 'past'] as const;

export const VisitorQuerySchema = z.object({
  orgId: IdSchema,
  tab: z.enum(VISITOR_TABS).default('today'),
  /** The browser's local day, as epoch ms, so Today follows the viewer's clock. */
  dayStart: z.coerce.number().int().nonnegative(),
  dayEnd: z.coerce.number().int().nonnegative(),
});

export const VisitorSchema = z.object({
  id: IdSchema,
  passId: IdSchema,
  name: z.string(),
  hostName: z.string(),
  windowFrom: TimestampSchema,
  windowUntil: TimestampSchema,
  note: z.string().nullable(),
  status: VisitorStatusSchema,
  /** When the status began: the arrival, the departure, or null before. */
  statusAt: TimestampSchema.nullable(),
  /** The window ended with them still in: shown as out at the window's end. */
  autoOut: z.boolean(),
  /** Set once the pass email was asked for. */
  hasEmail: z.boolean(),
});
export type Visitor = z.infer<typeof VisitorSchema>;

export const VisitorListSchema = pageOf(VisitorSchema);

export const NewVisitorSchema = z
  .strictObject({
    orgId: IdSchema,
    name: PlainLineSchema(80),
    email: EmailSchema.optional(),
    /** A member of the org, chosen from the host list. Or type a host: name and email (members:manage). */
    hostUserId: IdSchema.optional(),
    hostName: PlainLineSchema(80).optional(),
    hostEmail: EmailSchema.optional(),
    windowFrom: TimestampSchema,
    windowUntil: TimestampSchema,
    note: PlainLineSchema(100).optional(),
    /** A guest-plan template of the org; the newest one when left out. */
    templateId: IdSchema.optional(),
  })
  .refine((v) => v.hostUserId !== undefined || (v.hostName && v.hostEmail), {
    message: 'Choose a host.',
    path: ['hostUserId'],
  });
export type NewVisitor = z.infer<typeof NewVisitorSchema>;

export const VisitorParamsSchema = z.object({ id: IdSchema });
export const VisitorOrgQuerySchema = z.object({ orgId: IdSchema });

export const HostListSchema = z.object({
  /** Emails come only with members:manage. */
  items: z.array(z.object({ id: IdSchema, name: z.string(), email: z.string().nullable() })),
  nextCursor: z.string().nullable(),
});
