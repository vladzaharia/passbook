import { z } from 'zod';

/**
 * The `tagProgram` bridge feature (wire v2, additive like `scanAck`): the app holds one tag session open and
 * relays APDUs from the page. Types only until the apps and `native-reader.ts` speak it.
 */
export const TAG_PROGRAM_FEATURE = 'tagProgram';

const Hex = z
  .string()
  .regex(/^(?:[0-9a-fA-F]{2})+$/)
  .max(520);

/** Web to app. */
export const TagProgramOpSchema = z.discriminatedUnion('op', [
  /** Opens the sheet and holds the first ISO-DEP tag until `tagSessionEnd` or loss. */
  z.object({
    op: z.literal('tagSession'),
    id: z.string().min(1).max(100),
    prompt: z.string().min(1).max(200),
    timeoutMs: z.number().int().positive().max(60_000),
  }),
  /** Sends `apdus` in order, stopping at the first status word outside 9100 and 9000. */
  z.object({
    op: z.literal('apdu'),
    id: z.string().min(1).max(100),
    session: z.string().min(1).max(100),
    apdus: z.array(Hex).min(1).max(32),
  }),
  z.object({
    op: z.literal('tagSessionEnd'),
    session: z.string().min(1).max(100),
    /** Shown on the system sheet, as `alertMessage` on iOS. */
    message: z.string().max(200).optional(),
  }),
]);
export type TagProgramOp = z.infer<typeof TagProgramOpSchema>;

/** App to web. */
export const TagProgramEventSchema = z.discriminatedUnion('event', [
  z.object({
    event: z.literal('tagSession'),
    id: z.string().min(1).max(100),
    session: z.string().min(1).max(100),
    uid: z.string().regex(/^[0-9a-fA-F]{14}$/),
  }),
  /** One response per APDU sent, as far as the run got. `refused` names an APDU the allow-list stopped. */
  z.object({
    event: z.literal('apdu'),
    id: z.string().min(1).max(100),
    session: z.string().min(1).max(100),
    responses: z.array(Hex).max(32),
    refused: z.literal('APDU_REFUSED').optional(),
  }),
  z.object({ event: z.literal('tagLost'), session: z.string().min(1).max(100) }),
]);
export type TagProgramEvent = z.infer<typeof TagProgramEventSchema>;
