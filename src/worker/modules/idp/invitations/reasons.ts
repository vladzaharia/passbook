/** Why an invitation writes to Polaris ID, as the binding's ledger takes it: lowercase words joined by `_`. Its policy refuses anything else, a dot included. */
export const INVITE_REASON = {
  setup: 'invitation_setup',
  claim: 'invitation_claim',
  find: 'invitation_find',
  revoked: 'invitation_revoked',
  accepted: 'invitation_accepted',
} as const;
