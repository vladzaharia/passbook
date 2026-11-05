/**
 * The authored `scan.display` document (DM 6.2). Strict zod, shape only: the semantic rules
 * (density, secrets, references) belong to `scanDisplayIssues`. The worker, tools and the designer
 * import this file directly; `/scan` never does (it imports `icons.ts` and the rendered contract).
 */
import { z } from 'zod';
import { checkExpr } from '../expr.ts';
import { SCAN_ICONS } from './icons.ts';

export const SCAN_DISPLAY_MAX_BYTES = 16 * 1024;
const MAX_INTERPOLATIONS = 8;

const interpolations = (value: string) => value.split('{{').length - 1;

export const ScanIconIdSchema = z.enum(SCAN_ICONS);
export const ScanToneSchema = z.enum(['neutral', 'teal', 'violet', 'gold']);
export const ScanPresetIdSchema = z.enum([
  'membership',
  'loyalty',
  'balance',
  'ticket',
  'offer',
  'access',
  'details',
  'note',
]);
export const ScanRoleDocSchema = z.enum(['door', 'desk', 'manager']);
const ScreenSchema = z.enum(['ready', 'ok', 'heads_up']);

/** A text with `{{path|filter}}` parts, or a plural. Caps are the validator's (they differ per slot). */
export const ScanTextSchema = z.union([
  z.string().max(512),
  z.strictObject({
    count: z.string().max(256),
    one: z.string().max(512),
    other: z.string().max(512),
    zero: z.string().max(512).optional(),
  }),
]);

/** An expression: a string the template language accepts, with at most 8 interpolations. */
export const ScanExprSchema = z
  .string()
  .max(256)
  .refine((value) => interpolations(value) <= MAX_INTERPOLATIONS, 'Use at most 8 interpolations.')
  .refine((value) => checkExpr(value) === null, 'Not a valid expression.');

const IdSchema = z.string().regex(/^[a-z][a-z0-9_]{0,23}$/);
const SlotSchema = z.string().regex(/^[a-z][a-z0-9_]{0,23}$/);
const NumberOp = z.number().finite();

const DaysOps = z
  .strictObject({
    gt: NumberOp.optional(),
    gte: NumberOp.optional(),
    lt: NumberOp.optional(),
    lte: NumberOp.optional(),
  })
  .refine((v) => Object.keys(v).length === 1, 'Use one comparison.');

export type ScanCond =
  | {
      path: string;
      eq?: unknown;
      in?: unknown[];
      empty?: boolean;
      gt?: number;
      gte?: number;
      lt?: number;
      lte?: number;
      daysFromNow?: { gt?: number; gte?: number; lt?: number; lte?: number };
    }
  | { input: string; eq?: unknown; in?: unknown[]; empty?: boolean }
  | { all: ScanCond[] }
  | { any: ScanCond[] }
  | { not: ScanCond };

const PathLeaf = z
  .strictObject({
    path: z.string().min(1).max(128),
    eq: z.json().optional(),
    in: z.array(z.json()).max(20).optional(),
    empty: z.boolean().optional(),
    gt: NumberOp.optional(),
    gte: NumberOp.optional(),
    lt: NumberOp.optional(),
    lte: NumberOp.optional(),
    daysFromNow: DaysOps.optional(),
  })
  .refine((v) => Object.keys(v).length === 2, 'Use one comparison.');
const InputLeaf = z
  .strictObject({
    input: z.string().min(1).max(64),
    eq: z.json().optional(),
    in: z.array(z.json()).max(20).optional(),
    empty: z.boolean().optional(),
  })
  .refine((v) => Object.keys(v).length === 2, 'Use one comparison.');

/** Depth and leaf count are the validator's (`SCAN_DISPLAY_CONDITION`). */
export const ScanCondSchema: z.ZodType<ScanCond> = z.lazy(() =>
  z.union([
    PathLeaf,
    InputLeaf,
    z.strictObject({ all: z.array(ScanCondSchema).min(1).max(12) }),
    z.strictObject({ any: z.array(ScanCondSchema).min(1).max(12) }),
    z.strictObject({ not: ScanCondSchema }),
  ]),
);

const element = {
  id: IdSchema,
  when: ScanCondSchema.optional(),
  minRole: ScanRoleDocSchema.optional(),
};

export const ScanChipDocSchema = z.strictObject({
  ...element,
  text: ScanTextSchema,
  tone: ScanToneSchema,
  icon: ScanIconIdSchema.optional(),
});

const row = { ...element, slot: SlotSchema.optional() };

export const ScanRowDocSchema = z.discriminatedUnion('type', [
  z.strictObject({
    ...row,
    type: z.literal('heading'),
    text: ScanTextSchema,
    detail: ScanTextSchema.optional(),
  }),
  z.strictObject({
    ...row,
    type: z.literal('field'),
    label: ScanTextSchema,
    value: ScanTextSchema,
    icon: ScanIconIdSchema.optional(),
    strong: z.boolean().optional(),
    whenEmpty: z.enum(['hide', 'dash']).optional(),
  }),
  z.strictObject({
    ...row,
    type: z.literal('big'),
    label: ScanTextSchema.optional(),
    value: ScanTextSchema,
    unit: ScanTextSchema.optional(),
    tone: ScanToneSchema.optional(),
  }),
  z.strictObject({
    ...row,
    type: z.literal('columns'),
    size: z.enum(['big', 'normal']).optional(),
    items: z
      .array(z.strictObject({ id: IdSchema, label: ScanTextSchema, value: ScanTextSchema }))
      .min(2)
      .max(4),
  }),
  z.strictObject({
    ...row,
    type: z.literal('progress'),
    value: ScanExprSchema,
    goal: z.union([ScanExprSchema, z.number().int().min(1).max(1000)]).optional(),
    reward: ScanTextSchema.optional(),
    rewards: ScanExprSchema.optional(),
    icon: ScanIconIdSchema.optional(),
    style: z.enum(['auto', 'stamps', 'bar']).optional(),
  }),
  z.strictObject({
    ...row,
    type: z.literal('money'),
    label: ScanTextSchema.optional(),
    amount: ScanExprSchema,
    currency: z.string().max(256).optional(),
    lowBelow: z.number().finite().optional(),
    pending: z.array(IdSchema).max(6).optional(),
  }),
  z.strictObject({
    ...row,
    type: z.literal('history'),
    source: z.enum(['value', 'visits', 'scans']),
    input: z.string().min(1).max(64).optional(),
    limit: z.number().int().min(1).max(5).optional(),
    show: z
      .array(z.enum(['amount', 'when', 'where', 'action']))
      .max(4)
      .optional(),
  }),
  z.strictObject({
    ...row,
    type: z.literal('image'),
    source: z.enum(['thumbnail', 'strip']),
    title: ScanTextSchema.optional(),
    detail: ScanTextSchema.optional(),
  }),
  z.strictObject({
    ...row,
    type: z.literal('chips'),
    items: z.array(ScanChipDocSchema).min(1).max(4),
  }),
  z.strictObject({
    ...row,
    type: z.literal('list'),
    pair: z.boolean().optional(),
    items: z
      .array(
        z.strictObject({
          ...element,
          icon: ScanIconIdSchema,
          text: ScanTextSchema,
          detail: ScanTextSchema.optional(),
        }),
      )
      .min(1)
      .max(4),
  }),
  z.strictObject({
    ...row,
    type: z.literal('note'),
    text: ScanTextSchema,
    tone: z.enum(['neutral', 'info', 'attention']).optional(),
    icon: ScanIconIdSchema.optional(),
  }),
  z.strictObject({ ...row, type: z.literal('divider') }),
]);

export const ScanPanelDocSchema = z.strictObject({
  ...element,
  preset: z.strictObject({ id: ScanPresetIdSchema, v: z.number().int().min(1) }).optional(),
  title: ScanTextSchema.optional(),
  icon: ScanIconIdSchema.optional(),
  tone: ScanToneSchema.optional(),
  on: z.array(ScreenSchema).min(1).max(3).optional(),
  actions: z.array(IdSchema).max(6).optional(),
  rows: z.array(ScanRowDocSchema).min(1).max(6),
});

export const ScanPhotoSchema = z.strictObject({ minRole: ScanRoleDocSchema.optional() });

const HeaderSchema = z.strictObject({
  icon: ScanIconIdSchema.nullable().optional(),
  title: ScanTextSchema.nullable().optional(),
  subtitle: ScanTextSchema.nullable().optional(),
  chips: z.array(ScanChipDocSchema).max(2).optional(),
});

export const ScanVariantSchema = z.strictObject({
  id: IdSchema,
  name: z.string().min(1).max(24),
  when: ScanCondSchema,
  header: HeaderSchema,
});

export const ScanDisplayDocSchema = z.strictObject({
  v: z.literal(1),
  holder: ScanExprSchema.optional(),
  photo: ScanPhotoSchema.optional(),
  currency: z.string().max(256).optional(),
  header: HeaderSchema,
  variants: z.array(ScanVariantSchema).max(8).optional(),
  panels: z.array(ScanPanelDocSchema).max(6).optional(),
  notes: z
    .strictObject({
      staff: ScanTextSchema.nullable().optional(),
      refused: z.string().max(100).nullable().optional(),
    })
    .optional(),
});

export type ScanDisplayDoc = z.infer<typeof ScanDisplayDocSchema>;
export type ScanPanelDoc = z.infer<typeof ScanPanelDocSchema>;
export type ScanRowDoc = z.infer<typeof ScanRowDocSchema>;
export type ScanChipDoc = z.infer<typeof ScanChipDocSchema>;
export type ScanText = z.infer<typeof ScanTextSchema>;
export type ScanPresetId = z.infer<typeof ScanPresetIdSchema>;
