/** Server codes the assign machine maps to what the card shows. */
import type { AssignState } from './assign-state.ts';

export const PASS_BANNERS: Record<string, AssignState['banner']> = {
  PASS_NOT_FOUND: 'not_found',
  TAG_PASS_VOIDED: 'voided',
  TAG_PASS_REMOVED: 'removed',
  TAG_PASS_EXPIRED: 'expired',
  TAG_PASS_NOT_ACCEPTED: 'not_accepted',
  TAG_CARD_AMBIGUOUS: 'ambiguous',
};

/** Refusals of the person scope, and the note each one leaves on the confirm card. */
export const SCOPE_NOTES: Record<string, 'person_off' | 'type_pass'> = {
  TAG_ASSIGN_FORBIDDEN: 'person_off',
  TAG_TYPE_SCOPE: 'type_pass',
};
