import { defineOperationKind } from '../define.ts';

/**
 * Replaces an org's passes on one identity with passes on another. The operation issues and announces the
 * replacements; the old passes void later, one at a time, 24 hours after their replacement registers
 * (`modules/passes/identity-move.ts`). A platform kind: only an admin session reads, stops or retries it.
 */
export const identityMove = defineOperationKind({
  kind: 'identity.move',
  audience: 'platform',
  read: null,
  write: null,
  // Replacements already issued stay and keep working.
  cancel: 'between-steps',
  retry: true,
  stepUp: true,
  dedupe: (s) => `identity-move:${s.orgId}`,
  stallMs: 10 * 60_000,
  title: 'Move passes',
  doneTitle: 'Replacement passes sent',
  failTitle: 'Could not move passes',
  steps: [
    { key: 'plan', label: 'Find passes', active: 'Finding passes' },
    {
      key: 'issue',
      label: 'Issue replacements',
      active: 'Issuing replacements',
      counts: true,
    },
    { key: 'notify', label: 'Tell holders', active: 'Telling holders', counts: true },
  ],
  errors: {
    IDENTITY_MOVE_PARTIAL: 'Some passes were not moved. Retry.',
    IDENTITY_MOVE_PARAMS: 'The move lost its settings. Start it again.',
    IDENTITY_RETIRED: 'The new identity cannot issue passes. Pick another and start again.',
    IDENTITY_EXPIRED: 'The new identity has expired. Renew it, then retry.',
    ORG_NOT_FOUND: 'The organization is gone.',
  },
});
