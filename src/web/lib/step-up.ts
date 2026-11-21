// A sensitive action answered STEP_UP_REQUIRED: the dialog (a lazy chunk) asks the person to sign in
// again. The action is not replayed; they come back to the same page and click it again. This store
// stays in the entry chunk and holds no React, so the dialog costs nothing until it is needed.
export const isStepUp = (error: unknown) =>
  (error as { code?: string } | null)?.code === 'STEP_UP_REQUIRED';

let pending: string | null = null;
// One dialog, one subscriber.
const idle = () => {};
let notify: () => void = idle;

const set = (next: string | null) => {
  pending = next;
  notify();
};

/** Opens the step-up dialog. `signInUrl` is the server's, with `next` replaced by the current page at click time. */
export const requestStepUp = (signInUrl: string | undefined) => set(signInUrl ?? '');

export const dismissStepUp = () => set(null);
export const pendingStepUp = () => pending;
export const subscribeStepUp = (listener: () => void) => {
  notify = listener;
  return () => {
    notify = idle;
  };
};
