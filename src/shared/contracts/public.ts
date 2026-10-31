import { z } from 'zod';

export const PublicTokenParamSchema = z.object({ token: z.string().min(16).max(128) });
export const PublicAssetParamSchema = PublicTokenParamSchema.extend({ name: z.string().max(200) });

/** /p/:token and the pass download are HTML / binary; this describes the JSON handoff for QR codes. */
export const PublicLinkSchema = z.object({
  publicUrl: z.string(),
  downloadUrl: z.string(),
  qrPayload: z.string(),
});
