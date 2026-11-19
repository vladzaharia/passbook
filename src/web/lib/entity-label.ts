const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const HASH = /^[0-9a-f]{12,}$/i;
const PREFIXED = /^[a-z]+_[0-9a-z]{10,}$/i;

/** A UUID, a hex hash or a prefixed token: what a person never reads as a name. */
export const looksLikeId = (value: string): boolean =>
  UUID.test(value) || HASH.test(value) || PREFIXED.test(value);

/**
 * The one display-name rule: a record's own name when it has one, else its plain kind ("Pass",
 * "User"). Never an id or hash, never a slice of one. Ids stay reachable through TechnicalDetails.
 */
export function entityLabel(name: string | null | undefined, kind: string): string {
  const trimmed = name?.trim();
  return trimmed && !looksLikeId(trimmed) ? trimmed : kind;
}
