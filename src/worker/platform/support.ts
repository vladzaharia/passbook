import { strictEmail } from '../../shared/email.ts';

/** PassBook's own support address (`vars.SUPPORT_EMAIL`); null when unset or invalid. */
export function platformSupportEmail(env: object): string | null {
  return strictEmail((env as Record<string, unknown>).SUPPORT_EMAIL);
}
