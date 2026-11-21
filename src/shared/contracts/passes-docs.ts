/** Field descriptions for POST /passes: when each optional identifier applies. */
export const CREATE_PASS_DOCS = {
  input: "The template's fields. GET /templates/{id}/input-schema returns the schema.",
  externalId:
    'Your own key for the pass, any time. Filter with GET /passes?externalId=. Unique per org and mode only if the template says so.',
  serial:
    "Sets the Wallet serial. Honored only on the organization's own signing identity; the platform identity picks its own.",
  connectionId: 'Binds the pass to a connection. Send with externalRef.',
  externalRef:
    'The upstream record id, for passes created by a connection. Send with connectionId.',
} as const;
