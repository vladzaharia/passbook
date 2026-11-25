import { normalizeEmail, strictEmail } from '../../../shared/email.ts';

export interface EmailChip {
  email: string;
  valid: boolean;
}

/** Splits pasted or typed text on commas, semicolons, whitespace and newlines. */
export function splitEmails(text: string): string[] {
  return text
    .split(/[\s,;]+/)
    .map((part) => part.trim())
    .filter(Boolean);
}

/** Adds the addresses in `text` to `chips`, once each, marking the ones the server would refuse. */
export function addEmails(chips: readonly EmailChip[], text: string): EmailChip[] {
  const next = [...chips];
  for (const raw of splitEmails(text)) {
    const email = normalizeEmail(raw);
    if (next.some((chip) => chip.email === email)) continue;
    next.push({ email, valid: strictEmail(email) !== null });
  }
  return next;
}
