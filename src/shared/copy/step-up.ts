/** The step-up dialog (loaded on demand, so kept out of the shared sign-in copy). */
export const STEP_UP_COPY = {
  title: "Confirm it's you",
  body: 'This needs a recent sign-in. Continue, then try again.',
  confirm: 'Continue with Polaris ID',
} as const;

/** The callback page when Polaris ID answered a step-up without asking the person again. */
export const STEP_UP_NOT_FRESH_COPY = {
  title: 'Not confirmed',
  message: "Polaris ID didn't ask you to sign in again. Try again.",
  retry: 'Try again',
} as const;
