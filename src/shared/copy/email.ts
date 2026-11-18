/** Words for what happened to a pass email, shared by the API and the admin toasts. */

/** The cap a refused send hit: the org's daily cap, or one recipient's hourly cap. */
export const EMAIL_LIMIT_COPY = {
  org: 'Daily email limit reached. The rest send tomorrow.',
  recipient: 'This address reached its hourly email limit. Try again within the hour.',
} as const;

/**
 * What issuing a pass with an email came to: `scheduleIssuanceDelivery`'s outcomes
 * (`queued`, `deferred`, `cancelled`, `none`), with `deferred` split by the cap that held it.
 */
export const ISSUANCE_OUTCOMES = [
  'queued',
  'deferred',
  'limited_org',
  'limited_recipient',
  'cancelled',
  'none',
] as const;
export type IssuanceOutcome = (typeof ISSUANCE_OUTCOMES)[number];

export const ISSUANCE_OUTCOME_COPY: Record<IssuanceOutcome, string> = {
  queued: 'Email queued.',
  deferred: 'Email waits for the pass to finish updating, then sends.',
  limited_org: EMAIL_LIMIT_COPY.org,
  limited_recipient: EMAIL_LIMIT_COPY.recipient,
  cancelled: 'The email was cancelled because the pass changed. Send it again.',
  none: 'No email was queued. Add a holder email and send it again.',
};
