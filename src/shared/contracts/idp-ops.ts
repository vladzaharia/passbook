import { z } from 'zod';
import { IdSchema } from './common.ts';

/** `POST /platform/idp/reconcile`: Check now. `dryRun` forces a dry run even while Polaris ID is live. */
export const ReconcileIdpSchema = z.strictObject({ dryRun: z.boolean().default(false) });
export type ReconcileIdp = z.infer<typeof ReconcileIdpSchema>;

/** The roles PassBook adds in Polaris ID and can hold for its owner. */
export const IdpRoleSchema = z.enum(['console', 'developer', 'support']);

export const HoldParamSchema = z.object({ id: IdSchema, role: IdpRoleSchema });
