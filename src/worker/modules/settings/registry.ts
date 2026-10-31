import type { z } from 'zod';
import { OrgSettingsSchema, PlatformSettingsSchema } from '../../../shared/contracts/settings.ts';

export interface SettingDef {
  key: string;
  schema: z.ZodType;
  /** Undefined when the setting has no default (optional org settings). */
  default: unknown;
}

type ObjectSchema = typeof PlatformSettingsSchema | typeof OrgSettingsSchema;

function defsOf(schema: ObjectSchema): Map<string, SettingDef> {
  const defs = new Map<string, SettingDef>();
  for (const [key, field] of Object.entries(schema.shape) as [string, z.ZodType][]) {
    const parsed = field.safeParse(undefined);
    defs.set(key, { key, schema: field, default: parsed.success ? parsed.data : undefined });
  }
  return defs;
}

const PLATFORM = defsOf(PlatformSettingsSchema);
const ORG = defsOf(OrgSettingsSchema);

/** Registry for a scope string (`platform` or `org:<id>`). */
export function registryFor(scope: string): Map<string, SettingDef> {
  return scope === 'platform' ? PLATFORM : ORG;
}

export function orgIdOfScope(scope: string): string | null {
  return scope.startsWith('org:') ? scope.slice(4) : null;
}
