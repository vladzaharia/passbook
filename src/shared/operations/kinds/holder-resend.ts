import { defineOperationKind } from '../define.ts';
import { holderCommon, holderDedupe, holderErrors } from '../holder.ts';

export const holderResend = defineOperationKind({
  ...holderCommon,
  kind: 'holder.resend',
  dedupe: holderDedupe('holder.resend'),
  errors: holderErrors,
  title: 'Email my pass',
  doneTitle: 'Email on its way',
  failTitle: 'Could not send the email',
  steps: [
    { key: 'check', label: 'Check the pass', active: 'Checking your pass' },
    { key: 'mail', label: 'Send the email', active: 'Sending the email' },
  ],
});
