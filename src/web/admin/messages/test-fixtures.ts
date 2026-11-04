import type { BroadcastDto } from '@/shared/contracts/broadcasts.ts';

/** A contract-shaped broadcast for page tests. */
export const broadcast = (over: Partial<BroadcastDto> = {}): BroadcastDto => ({
  id: 'b1',
  orgId: 'o1',
  mode: 'live',
  kind: 'message',
  name: 'Doors open late',
  state: 'sent',
  target: { templateIds: ['t1'] },
  patch: { message: 'Doors open at 8.' },
  notify: true,
  at: null,
  clearAfter: null,
  parentId: null,
  followUp: null,
  counts: { targeted: 2, updated: 2, unchanged: 0, overBudget: 0, failed: 0 },
  errorCode: null,
  createdAt: Date.now() - 60_000,
  startedAt: Date.now() - 60_000,
  finishedAt: Date.now() - 30_000,
  ...over,
});
