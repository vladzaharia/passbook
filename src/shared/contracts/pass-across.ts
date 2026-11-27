import { z } from 'zod';
import { IdSchema } from './common.ts';

/** Sent only on lists across organizations (`orgId=all`). */
export const PassAcrossShape = {
  /** The organization's name ("Personal" for your own personal org). */
  orgName: z.string().optional(),
  /** The template's name. */
  templateName: z.string().optional(),
  /** The organization's time zone, for the dates. */
  timeZone: z.string().optional(),
};

/** With orgId=all: only these organizations (comma-separated, up to 50). Each must be readable. */
export const PassOrgIdsSchema = z
  .string()
  .max(64 * 50 + 49)
  .transform((v) => v.split(',').map((id) => id.trim()))
  .pipe(z.array(IdSchema).min(1).max(50));

/** A query value holding JSON: parsed, or one validation issue. */
export const jsonParam = (what: string) => (raw: string, ctx: z.RefinementCtx) => {
  try {
    return JSON.parse(raw) as unknown;
  } catch {
    ctx.addIssue({ code: 'custom', message: `Use a JSON ${what}.` });
    return z.NEVER;
  }
};
