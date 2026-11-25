import { z } from 'zod';
import { IdSchema, TimestampSchema } from './common.ts';
import { TagBindingSchema, TagReadSchema, TagScopeSchema, TagUidSchema } from './nfc-tags.ts';

/**
 * Programming a blank NTAG 424 DNA at a scanner. The Worker runs the secure messaging and the device relays
 * opaque APDUs, so every APDU and response here is hex and no key ever crosses the wire. Design:
 * `docs/design/` (nfc-program).
 */

/** Even-length hex, at most one short APDU (255 data bytes plus header, Le and status). */
const HexSchema = z
  .string()
  .regex(/^(?:[0-9a-fA-F]{2})+$/, 'Expected hex.')
  .max(520);

export const TagProgramPurposeSchema = z.enum(['blank', 'rekey']);

/** `started` waits for the device's answer to auth part 2; `scripted` has released the script. */
export const TagProgramStateSchema = z.enum([
  'started',
  'scripted',
  'programmed',
  'interrupted',
  'failed',
  'reset',
  'abandoned',
]);
export type TagProgramState = z.infer<typeof TagProgramStateSchema>;

/** `TAG_LOST` is the shared code in `nfc-tag-errors.ts`; the rest are new here. */
export const TAG_PROGRAM_ERROR_CODES = [
  'TAG_LOST',
  'TAG_NOT_BLANK',
  'TAG_NOT_424',
  'TAG_KNOWN',
  'TAG_NOT_GENUINE',
  'TAG_PROGRAM_EXPIRED',
  'TAG_PROGRAM_FAILED',
  'TAG_PROGRAM_RATE_LIMITED',
  'KEYSET_NOT_PROGRAMMABLE',
] as const;
export const TagProgramErrorCodeSchema = z.enum(TAG_PROGRAM_ERROR_CODES);
export type TagProgramErrorCode = z.infer<typeof TagProgramErrorCodeSchema>;

/** `POST /scan/tag-programs`: the tag's answers before any key is used. */
export const TagProgramStartSchema = z.strictObject({
  uid: TagUidSchema,
  /** The three GetVersion parts joined: 28 bytes. */
  version: HexSchema.length(56),
  /** The 56-byte originality signature. */
  sig: HexSchema.length(112),
  /** `E(K0, RndB)`: the tag's answer to auth part 1, run on the device with no key. */
  auth1: HexSchema.length(32),
  purpose: TagProgramPurposeSchema,
  keysetId: IdSchema.optional(),
  idem: z.string().min(8).max(100),
});
export type TagProgramStart = z.infer<typeof TagProgramStartSchema>;

export const TagProgramStartedSchema = z.object({
  id: IdSchema,
  /** The tag's open program for this UID was resumed. */
  resume: z.boolean(),
  /** Auth part 2. */
  apdus: z.array(HexSchema).min(1).max(1),
  expiresAt: TimestampSchema,
});

/** `POST /scan/tag-programs/{id}/auth`: the answer to auth part 2. */
export const TagProgramAuthSchema = z.strictObject({ responses: z.array(HexSchema).length(1) });

export const TagProgramScriptSchema = z.object({
  /** The whole post-auth script, run in order. */
  apdus: z.array(HexSchema).min(1).max(32),
  /** The device stops at the first status word not in this set (the native 9100, ISO 9000). */
  stopOn: z.literal('9100'),
});

/** `POST /scan/tag-programs/{id}/result`: every response, and the URL read back as a tap. */
export const TagProgramResultSchema = z.strictObject({
  responses: z.array(HexSchema).min(1).max(32),
  readback: TagReadSchema,
  bind: z.strictObject({ passId: IdSchema, scope: TagScopeSchema }).optional(),
  enrollmentId: IdSchema.optional(),
});

export const TagProgramDoneSchema = z.object({
  state: TagProgramStateSchema,
  tag: z.object({ id: IdSchema, hint: z.string().regex(/^[0-9A-F]{4}$/) }).nullable(),
  binding: TagBindingSchema.nullable(),
  /** Why the tag was set up but not assigned. */
  refusal: TagProgramErrorCodeSchema.nullable(),
});

export const TagProgramAbortWhySchema = z.enum(['lost', 'cancelled', 'timeout']);

/** `POST /scan/tag-programs/{id}/abort`. */
export const TagProgramAbortSchema = z.strictObject({
  responses: z.array(HexSchema).max(32),
  why: TagProgramAbortWhySchema,
});
export const TagProgramAbortedSchema = z.object({ state: z.literal('interrupted') });

/** One program as the console lists it: never the UID, only the hint. */
export const TagProgramSchema = z.object({
  id: IdSchema,
  state: TagProgramStateSchema,
  purpose: TagProgramPurposeSchema,
  hint: z.string().regex(/^[0-9A-F]{4}$/),
  scannerId: IdSchema.nullable(),
  attempts: z.number().int().nonnegative(),
  errorCode: TagProgramErrorCodeSchema.nullable(),
  createdAt: TimestampSchema,
  updatedAt: TimestampSchema,
});
