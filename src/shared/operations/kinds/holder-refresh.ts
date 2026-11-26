import { defineOperationKind } from '../define.ts';
import { holderCommon, holderDedupe, holderErrors } from '../holder.ts';

export const holderRefresh = defineOperationKind({
  ...holderCommon,
  kind: 'holder.refresh',
  dedupe: holderDedupe('holder.refresh'),
  errors: holderErrors,
  title: 'Refresh pass',
  doneTitle: 'Pass updated',
  failTitle: 'Could not refresh the pass',
  steps: [
    { key: 'check', label: 'Check the pass', active: 'Checking your pass' },
    { key: 'build', label: 'Rebuild the pass', active: 'Rebuilding your pass' },
    { key: 'wallets', label: 'Update your wallets', active: 'Updating your wallets' },
  ],
});
