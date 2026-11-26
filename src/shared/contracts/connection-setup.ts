import { z } from 'zod';
import { RecipeIdSchema } from './connections.ts';

/** Plain text; `**bold**` and `` `code` `` only. */
const Text = z.string().max(400);
const Date10 = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);

/** A value the console fills in from the connection or endpoint. */
export const SetupFieldSchema = z.enum([
  'endpointUrl',
  'secret',
  'signatureHeader',
  'timestampHeader',
]);
export type SetupField = z.infer<typeof SetupFieldSchema>;

export const SetupPartSchema = z.discriminatedUnion('t', [
  z.object({ t: z.literal('text'), text: Text }),
  /** A menu path: Settings, Notifications, Webhooks. */
  z.object({ t: z.literal('path'), items: z.array(z.string().max(60)).max(6) }),
  /** A form field at the other side and what to put in it. */
  z.object({
    t: z.literal('field'),
    label: z.string().max(60),
    value: Text.optional(),
    copy: SetupFieldSchema.optional(),
    /** A choice the sender makes, not a value to copy. */
    choose: z.boolean().default(false),
  }),
  /** Renders `subscriptions.topics`. */
  z.object({ t: z.literal('topics') }),
  z.object({
    t: z.literal('code'),
    lang: z.enum(['sh', 'curl', 'ts', 'py', 'go']),
    code: z.string().max(4000),
  }),
  z.object({ t: z.literal('note'), text: Text }),
  z.object({ t: z.literal('warn'), text: Text }),
]);
export type SetupPart = z.infer<typeof SetupPartSchema>;

export const SetupStepSchema = z.object({
  id: z.string().max(40),
  side: z.enum(['provider', 'passbook']),
  title: z.string().max(80),
  parts: z.array(SetupPartSchema).max(12),
  /** False: the labels may differ at the sender, and the console says so. */
  verified: z.boolean().default(true),
});
export type SetupStep = z.infer<typeof SetupStepSchema>;

/** Keys of `troubleshooting`: what the arrival ledger saw. `none` is no arrival at all. */
export const SETUP_TROUBLE_KEYS = [
  'none',
  'signature_missing',
  'signature_mismatch',
  'signature_expired',
  'payload',
  'too_large',
  'no_secret',
  'unknown_type',
  'thin_event',
  'test_mode',
  'unrecognized_shape',
  'no_ref',
  'ping',
  'stale',
] as const;

/** Keys of an outbound guide's `troubleshooting`: what a test send came back with. */
export const SETUP_SEND_TROUBLE_KEYS = [
  'refused',
  'wrong_path',
  'redirected',
  'server_error',
  'timeout',
  'unreachable',
] as const;

export const SetupGuideSchema = z.object({
  direction: z.enum(['inbound', 'outbound']),
  recipe: RecipeIdSchema.or(z.literal('outbound')),
  /** Bumps on any change to the steps. Content, not an API version. */
  version: Date10,
  /** Last checked against the sender's docs. */
  checkedAt: Date10,
  provider: z.object({
    name: z.string(),
    consoleUrl: z.url().nullable(),
    docs: z.array(z.object({ label: z.string(), url: z.url() })).max(4),
  }),
  secret: z.object({
    /** Who makes the secret: the sender (paste it here) or PassBook (paste it there). */
    origin: z.enum(['provider', 'passbook']),
    allowPaste: z.boolean(),
    prefix: z.string().max(10).nullable(),
    minLength: z.number().int(),
    /** Id of the step that shows where to find it. */
    whereStep: z.string().nullable(),
  }),
  subscriptions: z.object({
    perWebhook: z.enum(['one', 'many']),
    topics: z.array(
      z.object({
        id: z.string(),
        label: z.string().nullable(),
        required: z.boolean(),
        verified: z.boolean(),
      }),
    ),
  }),
  steps: z.array(SetupStepSchema).max(12),
  test: z.object({
    kind: z.enum(['button', 'ping-on-save', 'cli', 'real-event', 'snippet', 'send']),
    text: Text,
    command: z.string().max(200).nullable(),
    /** Whether the test can issue a pass. */
    issues: z.boolean(),
  }),
  /** Ledger reason (or `none`) to the fix line for this sender. */
  troubleshooting: z.record(z.string(), Text),
});
export type SetupGuide = z.infer<typeof SetupGuideSchema>;
/** The shape guides are written in: defaults not yet applied. */
export type SetupGuideInput = z.input<typeof SetupGuideSchema>;

export const RecipeSetupParamSchema = z.object({ recipe: RecipeIdSchema });

/** Values of one connection, filled into the guide. A secret is never among them. */
export const ConnectionSetupSchema = SetupGuideSchema.extend({
  values: z.object({
    endpointUrl: z.string().nullable(),
    signatureHeader: z.string().nullable(),
    timestampHeader: z.string().nullable(),
    hasSecret: z.boolean(),
  }),
});
export type ConnectionSetup = z.infer<typeof ConnectionSetupSchema>;
