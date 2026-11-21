import { checkFromName, PLATFORM_NAME } from '../../../shared/email-from-name.ts';
import type { ServiceContext } from '../../platform/service-context.ts';

/** The org's From name when it still passes the rules (the platform name may have changed since). */
export function orgFromName(
  ctx: ServiceContext,
  stored: string | undefined,
  platformName: string,
): string | null {
  if (stored === undefined) return null;
  const checked = checkFromName(stored, platformName);
  if (checked.ok) return checked.value;
  ctx.log.warn('email.from_name_refused', { code: 'FROM_NAME_REFUSED' });
  return null;
}

/**
 * The name a pass email is written under. A personal org's stored name is its owner's, so the email
 * speaks for the platform instead ("Your PassBook pass").
 */
export function passEmailOrgName(org: { name: string; personal: boolean } | null): string {
  return org && !org.personal ? org.name : PLATFORM_NAME;
}
