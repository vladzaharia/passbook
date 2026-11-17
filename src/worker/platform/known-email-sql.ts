import { NO_EMAIL_LABEL, UNVERIFIED_EMAIL_SUFFIX } from '../../shared/email.ts';

/** SQL for a users email column: NULL for the placeholder of an account with no verified email. */
export const knownEmailSql = (column: string): string =>
  `CASE WHEN ${column} LIKE '%${UNVERIFIED_EMAIL_SUFFIX}' THEN NULL ELSE ${column} END`;

/** SQL for a person's label: the name, else the known email, else a plain "no email" label. */
export const personLabelSql = (name: string, email: string): string =>
  `COALESCE(${name}, ${knownEmailSql(email)}, CASE WHEN ${email} IS NOT NULL THEN '${NO_EMAIL_LABEL}' END)`;
