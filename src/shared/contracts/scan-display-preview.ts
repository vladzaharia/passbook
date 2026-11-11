import { z } from 'zod';
import { IdSchema, JsonSchema, ModeSchema } from './common.ts';
import { ScanRoleSchema } from './scan.ts';

/** The mode is explicit even for a live-mode console session. */
export const ScanDisplayPreviewQuerySchema = z.object({
  orgId: IdSchema,
  mode: ModeSchema,
  templateId: IdSchema,
  passId: IdSchema,
  role: ScanRoleSchema,
});

/** A role-filtered renderer scope, not a pass, manifest or rendered display. */
export const ScanDisplayPreviewSchema = z.object({
  scope: z.record(z.string(), JsonSchema),
});

export type ScanDisplayPreviewQuery = z.infer<typeof ScanDisplayPreviewQuerySchema>;
export type ScanDisplayPreview = z.infer<typeof ScanDisplayPreviewSchema>;
