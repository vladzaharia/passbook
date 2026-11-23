import type { BrandMark } from '../contracts/orgs.ts';

/**
 * The PassBook credit at the foot of holder pages, emails and print sheets, by the org's footer choice:
 * `lead` then `name` (set bold), or null when the org shows none or there is no org brand. The one place these words live.
 */
export function passbookCredit(mark: BrandMark | undefined): { lead: string; name: string } | null {
  if (mark === undefined || mark === 'none') return null;
  return mark === 'small'
    ? { lead: 'Powered by PassBook', name: '' }
    : { lead: 'Issued with', name: 'PassBook' };
}
