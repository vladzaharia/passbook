/** Words of CLI sign-in (`passbook login`), shared by the approve page, the API's problems and the CLI. */
export const CLI_CODE_NOT_FOUND_COPY = 'No such code. Check it against your terminal.';
export const CLI_CODE_EXPIRED_COPY = 'The code expired. Run passbook login again.';
export const CLI_CODE_DENIED_COPY = 'The sign-in was denied.';
export const CLI_AUTH_PENDING_COPY = 'Waiting for approval.';
export const CLI_SLOW_DOWN_COPY = 'Polling too fast. Wait for the interval.';
export const CLI_BUSY_COPY = 'Too many sign-ins are waiting. Try again shortly.';
export const CLI_ACCOUNT_MISMATCH_COPY =
  'Approved by a different account. Run passbook login --switch to change accounts.';
export const CLI_CODE_LOCKED_COPY = 'Too many wrong codes. Wait and try again.';

export const CLI_WARNING = 'Check the code matches before you approve.';
export const CLI_MISMATCH_WARNING =
  'This was started on a different network. Approve only if you ran passbook login yourself just now.';
export const cliAllows = (context: string) =>
  `Test data in ${context} for 30 days. Can't make keys or reach Live.`;

/** The approve page (`/workbench/cli`). */
export const CLI_PAGE = {
  title: 'Sign in the CLI',
  code: 'Code from your terminal',
  codeError: CLI_CODE_NOT_FOUND_COPY,
  next: 'Continue',
  account: 'Account',
  notYou: 'Not you? Sign in as someone else',
  started: 'Started',
  device: 'Reported by the device',
  context: 'Context',
  noContext: 'No Test context. Make a sandbox first.',
  approve: 'Approve',
  deny: 'Deny',
  approved: 'Approved. Return to your terminal.',
  denied: 'Denied.',
  accountMismatch: 'The CLI asked for a different account than this one.',
  unknownPlace: 'an unknown place',
} as const;
