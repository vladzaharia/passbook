import { IDENTITY_LINKED_BODY, IDENTITY_LINKED_SUBJECT } from '../../shared/copy/sign-in.ts';
import { notice } from './org-closed.ts';

/** To every other verified address of an account that just got a Polaris ID through a mail proof. */
export const identityLinkedEmail = (base: string) =>
  notice(base, IDENTITY_LINKED_SUBJECT, IDENTITY_LINKED_BODY);
