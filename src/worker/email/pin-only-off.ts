import { notice } from './org-closed.ts';

/** To every org admin when wrong PINs switch PIN-only sign-in off. */
export const pinOnlyOffEmail = (base: string, org: string) =>
  notice(
    base,
    `PIN-only sign-in is off for ${org}`,
    `Scanners were sent many wrong PINs, so ${org} now asks staff for their name as well as their PIN. Revoke any scanner you do not recognize. Turn it back on in the Staff tab when you are ready.`,
  );
