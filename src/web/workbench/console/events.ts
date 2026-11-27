/** Webhook events follow the call by a moment: ask once they have had it. */
export const EVENTS_AFTER_MS = 1500;

/** A string `secret` in the answer, at the top or one object down: a key or signing secret shown in full. */
export function showsSecret(json: unknown): boolean {
  if (json === null || typeof json !== 'object') return false;
  return Object.entries(json).some(
    ([k, v]) =>
      (k === 'secret' && typeof v === 'string') ||
      (v !== null &&
        typeof v === 'object' &&
        !Array.isArray(v) &&
        typeof (v as { secret?: unknown }).secret === 'string'),
  );
}
