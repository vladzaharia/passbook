const EMAIL_LABEL = '[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?';
const EMAIL_ADDR_SPEC = new RegExp(
  `^[a-z0-9!#$%&'*+/=?^_\`{|}~-]+(?:\\.[a-z0-9!#$%&'*+/=?^_\`{|}~-]+)*@${EMAIL_LABEL}(?:\\.${EMAIL_LABEL})+$`,
);

/** The one matching key for emails: trim, lower-case, NFC. No plus or dot folding. */
export function normalizeEmail(raw: string): string {
  return raw.trim().toLowerCase().normalize('NFC');
}

/** A bare ASCII addr-spec, normalized, or null. Rejects display names, quoting and lists. */
export function strictEmail(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const email = normalizeEmail(raw);
  if (email.length > 254) return null;
  const at = email.lastIndexOf('@');
  if (at < 1 || at > 64) return null;
  return EMAIL_ADDR_SPEC.test(email) ? email : null;
}
