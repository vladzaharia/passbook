import { SANDBOX_KEY_SCOPES } from './contracts/developer-home.ts';

/**
 * What a key is for, as scopes. One map for the portal's New key sheet and Admin's scope list: a preset is only
 * offered when every scope in it fits under the ceiling the caller holds.
 */
export const KEY_PRESETS = [
  { id: 'issue', label: 'Issue passes', scopes: ['passes:read', 'passes:write', 'templates:read'] },
  {
    id: 'read',
    label: 'Read only',
    scopes: ['passes:read', 'templates:read', 'scans:read', 'connections:read'],
  },
  { id: 'webhooks', label: 'Webhooks', scopes: ['webhooks:manage'] },
] as const;
export type KeyPresetId = (typeof KEY_PRESETS)[number]['id'];

/** The portal adds the whole ceiling to the three: every scope a sandbox key may hold. */
export const FULL_SANDBOX = { id: 'full', label: 'Full sandbox' } as const;

/** Expiry choices for a personal key (the server's limit is 90 days). */
export const KEY_EXPIRY_DAYS = [1, 7, 14, 30, 60, 90] as const;

/** A roll keeps the old key working this long beside the new one. */
export const ROLL_OVERLAP_HOURS = 1;

/** The presets whose scopes all fit under `ceiling`. */
export function presetsWithin(ceiling: readonly string[]) {
  return KEY_PRESETS.filter((p) => p.scopes.every((s) => ceiling.includes(s)));
}

/** The scopes a sandbox key may hold, in the contract's order. */
export const SANDBOX_CEILING: readonly string[] = SANDBOX_KEY_SCOPES;

/** The preset a set of scopes equals, else null (Pick scopes). Order does not matter. */
export function presetOf(
  scopes: readonly string[],
  ceiling: readonly string[] = SANDBOX_CEILING,
): string | null {
  const same = (a: readonly string[], b: readonly string[]) =>
    a.length === b.length && a.every((s) => b.includes(s));
  const hit = presetsWithin(ceiling).find((p) => same(p.scopes, scopes));
  if (hit) return hit.label;
  return same(ceiling, scopes) ? FULL_SANDBOX.label : null;
}

/** The line a developer pastes: the key, as an environment variable. */
export const envLine = (secret: string): string => `PASSBOOK_KEY=${secret}`;
