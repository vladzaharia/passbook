import { UNVERIFIED_EMAIL_SUFFIX } from '../../shared/email.ts';

/** SQL for a users email column: NULL for the placeholder of an account with no verified email. */
export const knownEmailSql = (column: string): string =>
  `CASE WHEN ${column} LIKE '%${UNVERIFIED_EMAIL_SUFFIX}' THEN NULL ELSE ${column} END`;
