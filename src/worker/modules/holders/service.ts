import type { ServiceContext } from '../../platform/service-context.ts';

/**
 * Workstream d owns this module; workstream e calls these. Keep the signatures.
 * Hook B: after `userId` verifies `email`, attach every waiting, unblocked pass with that holder email.
 * Returns the number of passes attached.
 */
export async function attachWaitingPassesForEmail(
  _ctx: ServiceContext,
  _userId: string,
  _email: string,
): Promise<number> {
  return 0;
}

/** "Remove from my passes": write the attach block, then clear the owner. */
export async function removePassFromUser(
  _ctx: ServiceContext,
  _passId: string,
  _userId: string,
): Promise<void> {}
