import { MARKETING_POLICY } from '@/shared/marketing.ts';

type Policy = { createHTML(s: string): string };
type TrustedTypesApi = { createPolicy(name: string, rules: Policy): Policy };

let policy: Policy | undefined;

/**
 * Wraps an HTML string for innerHTML and insertAdjacentHTML. Every caller passes markup built from
 * static strings in this folder, never anything a visitor typed, so the policy returns it as is.
 * Browsers without Trusted Types take the string unchanged.
 */
export function trustedHtml(html: string): string {
  const types = (globalThis as { trustedTypes?: TrustedTypesApi }).trustedTypes;
  if (!types) return html;
  policy ??= types.createPolicy(MARKETING_POLICY, { createHTML: (s: string) => s });
  return policy.createHTML(html);
}
