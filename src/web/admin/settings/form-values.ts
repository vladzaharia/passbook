import type { ReactNode } from 'react';
import type { z } from 'zod';
import type { SettingsListSchema } from '@/shared/contracts/settings.ts';
import type { SettingField } from './fields.ts';

type Entries = z.infer<typeof SettingsListSchema>['items'];

/** Server value if set, else the server default, else empty. */
export function currentValues(
  entries: Entries,
  fields: readonly SettingField[],
  platform: boolean,
): Record<string, unknown> {
  const kinds = new Map(fields.map((f) => [f.key, f.kind]));
  const out: Record<string, unknown> = {};
  // An org input is empty until the org sets its own value; the default shows as the placeholder.
  for (const e of entries)
    out[e.key] =
      !platform && e.source === 'default' && kinds.get(e.key) !== 'boolean'
        ? undefined
        : (e.value ?? e.default);
  return out;
}

/** A change that needs a danger confirm first; Cancel puts `key` back. */
export interface SaveGuard {
  key: string;
  title: string;
  description: ReactNode;
  confirmLabel: string;
}
