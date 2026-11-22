import { notice } from './org-closed.ts';

/** To every org admin, once a day, when PINs were shared, replaced by a device, or a named lockout cap was hit. */
export const pinDigestEmail = (base: string, org: string, lines: readonly string[]) =>
  notice(
    base,
    `PIN activity in ${org}`,
    `${lines.join(' ')} Reset a PIN in the Staff tab if it was not the person.`,
  );

/** At once, to every org admin, when wrong named PINs reach the day's alert level: someone may be guessing. */
export const pinOrgCapEmail = (base: string, org: string) =>
  notice(
    base,
    `Many wrong PINs in ${org}`,
    `Staff sign-ins and approvals in ${org} were sent over 300 wrong PINs today. Check Activity for the scanner, and revoke any you do not recognize. Correct PINs still work.`,
  );
