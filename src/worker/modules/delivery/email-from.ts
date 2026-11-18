import { strictEmail } from '../../../shared/email.ts';
import { checkFromName } from '../../../shared/email-from-name.ts';
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

/** Reply-to is the org's support address, when it is a valid one. */
export function replyToOf(supportEmail: string | null | undefined): string | undefined {
  return strictEmail(supportEmail) ?? undefined;
}
