import { strictEmail } from '../../../shared/email.ts';
import { baseUrl } from '../../platform/env.ts';
import { platformSupportEmail } from '../../platform/support.ts';

const domainOf = (address: string | null): string | null =>
  address ? address.slice(address.lastIndexOf('@') + 1) || null : null;

/** The domains the platform mails from and serves on: no org may point replies at them. */
export function platformMailDomains(env: {
  EMAIL_FROM: string;
  PUBLIC_BASE_URL: string;
}): string[] {
  const from = strictEmail(env.EMAIL_FROM) ?? env.EMAIL_FROM.match(/<([^>]+)>/)?.[1] ?? null;
  const host = (() => {
    try {
      return new URL(baseUrl(env)).hostname;
    } catch {
      return null;
    }
  })();
  return [domainOf(strictEmail(from)), host, domainOf(platformSupportEmail(env))]
    .filter((d): d is string => Boolean(d))
    .map((d) => d.toLowerCase());
}

/** True when the address is on a platform domain or a subdomain of one. */
export function isPlatformAddress(
  env: { EMAIL_FROM: string; PUBLIC_BASE_URL: string },
  address: string,
): boolean {
  const domain = domainOf(strictEmail(address));
  if (!domain) return false;
  return platformMailDomains(env).some((p) => domain === p || domain.endsWith(`.${p}`));
}
