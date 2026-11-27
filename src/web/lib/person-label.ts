import { NO_EMAIL_LABEL } from '../../shared/email.ts';

/** A person's label: the name, else the verified email, else a plain "no email" label. Apart from format.ts so the shell's user menu stays small. */
export const personLabel = (person: { name: string | null; primaryEmail: string | null }): string =>
  person.name ?? person.primaryEmail ?? NO_EMAIL_LABEL;
