import { keyedDigest } from '../../platform/crypto.ts';

/**
 * The mailbox an address reaches, for counting only (never stored or sent to): lower-case, no `+tag`,
 * and for Gmail no dots, googlemail.com folded to gmail.com. Sub-addresses share one budget.
 */
export function canonicalMailbox(address: string): string {
  const email = address.trim().toLowerCase();
  const at = email.lastIndexOf('@');
  if (at < 1) return email;
  const domain = email.slice(at + 1) === 'googlemail.com' ? 'gmail.com' : email.slice(at + 1);
  let local = email.slice(0, at).split('+')[0] ?? '';
  if (domain === 'gmail.com') local = local.replaceAll('.', '');
  return `${local}@${domain}`;
}

/** Counter key part for one recipient mailbox: keyed, so stored counters do not expose it. */
export const recipientKey = (env: object, to: string): Promise<string> =>
  keyedDigest(env, 'counter.pass-email.v1', canonicalMailbox(to));
