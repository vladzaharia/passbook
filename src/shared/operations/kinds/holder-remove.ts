import { defineOperationKind } from '../define.ts';
import { holderCommon, holderErrors } from '../holder.ts';

export const holderRemove = defineOperationKind({
  ...holderCommon,
  kind: 'holder.remove',
  errors: holderErrors,
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
