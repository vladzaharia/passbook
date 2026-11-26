import { defineOperationKind } from '../define.ts';
import { holderCommon, holderErrors } from '../holder.ts';

export const holderLostPhone = defineOperationKind({
  ...holderCommon,
  kind: 'holder.lost_phone',
  errors: {
    ...holderErrors,
    HOLDER_TRANSFER_PENDING:
      'The new pass was not sent: your wallets have not updated. Try again later.',
  },
  title: 'Lost phone',
  doneTitle: 'New pass sent',
  failTitle: 'Could not replace the pass',
  steps: [
    { key: 'rotate', label: 'Replace code and link', active: 'Replacing your code and link' },
    { key: 'signout', label: 'Sign out other devices', active: 'Signing out other devices' },
    { key: 'wallets', label: 'Update your wallets', active: 'Updating your wallets' },
    { key: 'mail', label: 'Email the new pass', active: 'Emailing the new pass' },
  ],
});
