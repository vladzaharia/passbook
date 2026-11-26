import { defineOperationKind } from '../define.ts';
import { holderCommon, holderErrors } from '../holder.ts';

export const holderRemove = defineOperationKind({
  ...holderCommon,
  kind: 'holder.remove',
  errors: {
    ...holderErrors,
    HOLDER_TRANSFER_PENDING: 'Your wallets have not let go yet. Check My passes later.',
  },
  title: 'Remove pass',
  doneTitle: 'Pass removed',
  failTitle: 'Could not remove the pass',
  steps: [
    { key: 'account', label: 'Take it off your account', active: 'Taking it off your account' },
    {
      key: 'wallets',
      label: 'Remove it from your wallets',
      active: 'Removing it from your wallets',
    },
  ],
});
