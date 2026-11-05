import type { z } from 'zod';
import type { TemplateDetailSchema } from '@/shared/contracts/templates.ts';

export type Template = z.infer<typeof TemplateDetailSchema>;

/** Version numbers by age, oldest first: the hash stays in the Versions tab. */
export function versionNumber(t: Pick<Template, 'versions'>, hash: string | null): number | null {
  if (!hash) return null;
  const byAge = [...t.versions].sort((a, b) => a.createdAt - b.createdAt);
  const at = byAge.findIndex((v) => v.version === hash);
  return at >= 0 ? at + 1 : null;
}

export const versionName = (n: number | null): string => (n ? `Version ${n}` : 'Version');
