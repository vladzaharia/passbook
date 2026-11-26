/** The `GROUPS` key for find-only alias names: a list of exact names, no ids. */
export const ALIASES_KEY = 'aliases';
const ALIAS_NAME = /^[A-Za-z0-9_.-]{1,100}$/;

/** The alias names, or null when the value is not a list of plain names. */
export function parseAliases(value: unknown): string[] | null {
  if (!Array.isArray(value) || value.some((n) => typeof n !== 'string' || !ALIAS_NAME.test(n)))
    return null;
  return value as string[];
}
