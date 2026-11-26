import { defineOperationKind } from '../define.ts';

export const walletReissue = defineOperationKind({
  kind: 'wallet.reissue',
  audience: 'org',
  read: 'passes:read',
  write: 'passes:operate',
  cancel: 'never',
  retry: true,
  stepUp: false,
  stallMs: 20 * 60_000,
  title: 'Update wallet passes',
  doneTitle: 'Passes updated',
  failTitle: 'Could not update passes',
  errors: {
    WALLET_REISSUE_KEYSET: 'Credentials are unavailable. Retry in a few minutes.',
    PROVIDER_OFF: 'This wallet is not on yet.',
    OPERATION_STALLED: 'The update stopped. Retry.',
  },
  steps: [{ key: 'copies', label: 'Update passes', active: 'Updating passes', counts: true }],
});
