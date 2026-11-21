import { notice } from './org-closed.ts';

/** To every org admin, once a day, when PINs were shared, replaced by a device, or a named lockout cap was hit. */
export const pinDigestEmail = (base: string, org: string, lines: readonly string[]) =>
  notice(
    base,
    `PIN activity in ${org}`,
    `${lines.join(' ')} Reset a PIN in the Staff tab if it was not the person.`,
  );
