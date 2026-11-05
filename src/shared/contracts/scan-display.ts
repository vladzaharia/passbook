import { z } from 'zod';
import { SCAN_ICONS } from '../../passkit/template/scan-display/icons.ts';

/**
 * The rendered result screen (DM 5.5): content, order and fit hints, never geometry or colour.
 * Imports only the icon ids from passkit, so `/scan` never bundles the authored schemas.
 */
export const ScanIconSchema = z.enum(SCAN_ICONS);
export const ScanDisplayToneSchema = z.enum(['neutral', 'teal', 'violet', 'gold']);
export const ScanNoteToneSchema = z.enum(['neutral', 'info', 'attention']);
export const ScanDisplayScreenSchema = z.enum(['ready', 'ok', 'heads_up', 'refused']);
export const SCAN_PRESET_KINDS = [
  'membership',
  'loyalty',
  'balance',
  'ticket',
  'offer',
  'access',
  'details',
  'note',
  'custom',
] as const;

export const ScanChipSchema = z.object({
  id: z.string(),
  text: z.string().min(1).max(16),
  tone: ScanDisplayToneSchema,
  icon: ScanIconSchema.nullable(),
});

const ColumnItemSchema = z.object({ label: z.string().max(12), value: z.string().max(16) });
const HistoryItemSchema = z.object({
  at: z.number().int().nullable(),
  when: z.string().nullable(),
  amount: z.string().nullable(),
  delta: z.number().nullable(),
  where: z.string().nullable(),
  label: z.string().nullable(),
  elsewhere: z.boolean(),
});

export const ScanDisplayRowSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('heading'),
    id: z.string(),
    text: z.string().max(24),
    detail: z.string().max(24).nullable(),
  }),
  z.object({
    type: z.literal('field'),
    id: z.string(),
    label: z.string().max(20),
    value: z.string().max(48),
    icon: ScanIconSchema.nullable(),
    strong: z.boolean(),
  }),
  z.object({
    type: z.literal('big'),
    id: z.string(),
    label: z.string().max(20).nullable(),
    value: z.string().max(12),
    unit: z.string().max(12).nullable(),
    tone: ScanDisplayToneSchema.nullable(),
  }),
  z.object({
    type: z.literal('columns'),
    id: z.string(),
    size: z.enum(['big', 'normal']),
    /** The compact-width layout verdict, so the client never measures text. */
    oneLine: z.boolean(),
    items: z.array(ColumnItemSchema).min(2).max(4),
  }),
  z.object({
    type: z.literal('progress'),
    id: z.string(),
    value: z.number(),
    goal: z.number().int().min(1).max(1000),
    before: z.number().nullable(),
    style: z.enum(['stamps', 'bar']),
    icon: ScanIconSchema.nullable(),
    rewards: z.number().int().nonnegative(),
    caption: z.string().max(48),
  }),
  z.object({
    type: z.literal('money'),
    id: z.string(),
    label: z.string().max(20).nullable(),
    amount: z.number(),
    currency: z
      .string()
      .regex(/^[A-Z]{3}$/)
      .nullable(),
    text: z.string().max(16),
    before: z.number().nullable(),
    change: z.number().nullable(),
    low: z.boolean(),
    pending: z.array(z.string()).max(6),
  }),
  z.object({
    type: z.literal('history'),
    id: z.string(),
    items: z.array(HistoryItemSchema).max(6),
    empty: z.string().nullable(),
  }),
  z.object({
    type: z.literal('image'),
    id: z.string(),
    source: z.enum(['thumbnail', 'strip']),
    url: z.string().nullable(),
    alt: z.string(),
    title: z.string().max(32).nullable(),
    detail: z.string().max(40).nullable(),
  }),
  z.object({
    type: z.literal('chips'),
    id: z.string(),
    items: z.array(ScanChipSchema).min(1).max(4),
  }),
  z.object({
    type: z.literal('list'),
    id: z.string(),
    pair: z.boolean(),
    oneLine: z.boolean(),
    items: z
      .array(
        z.object({
          id: z.string(),
          icon: ScanIconSchema,
          text: z.string().max(32),
          detail: z.string().max(24).nullable(),
        }),
      )
      .min(1)
      .max(4),
  }),
  z.object({
    type: z.literal('note'),
    id: z.string(),
    text: z.string().max(140),
    tone: ScanNoteToneSchema,
    icon: ScanIconSchema.nullable(),
  }),
  z.object({ type: z.literal('divider'), id: z.string() }),
]);

export const ScanDisplayPanelSchema = z.object({
  id: z.string(),
  kind: z.enum(SCAN_PRESET_KINDS),
  title: z.string().max(24).nullable(),
  icon: ScanIconSchema.nullable(),
  tone: ScanDisplayToneSchema.nullable(),
  rows: z.array(ScanDisplayRowSchema).min(1).max(6),
});

export const ScanDisplaySchema = z.object({
  v: z.literal(1),
  screen: ScanDisplayScreenSchema,
  templateVersion: z.string(),
  variant: z.string().nullable(),
  /** System slots filled from the doc's sources. Always set: an unknown pass has no display at all. */
  identity: z.object({
    holder: z.string().max(40),
    initials: z.string().max(2),
    /** Null: show the pass tile. */
    photo: z.object({ url: z.string().nullable(), alt: z.string() }).nullable(),
  }),
  header: z.object({
    icon: ScanIconSchema.nullable(),
    title: z.string().max(28).nullable(),
    titleLines: z.union([z.literal(1), z.literal(2)]),
    meta: z.string().max(60).nullable(),
    chips: z.array(ScanChipSchema).max(2),
  }),
  panels: z.array(ScanDisplayPanelSchema).max(2),
  notes: z.object({
    staff: z.string().max(140).nullable(),
    refused: z.string().max(100).nullable(),
  }),
});
export type ScanDisplay = z.infer<typeof ScanDisplaySchema>;
export type ScanDisplayRow = z.infer<typeof ScanDisplayRowSchema>;
export type ScanDisplayPanel = z.infer<typeof ScanDisplayPanelSchema>;
export type ScanChip = z.infer<typeof ScanChipSchema>;
export type ScanIcon = z.infer<typeof ScanIconSchema>;
