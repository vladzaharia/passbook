import type { toastImpl } from './toaster-impl.tsx';

export type Impl = typeof toastImpl;

let impl: Impl | undefined;
const queue: ((t: Impl) => void)[] = [];

/** Called by the mounted Toaster: flushes what was fired while the chunk loaded. */
export function toasterReady(t: Impl) {
  impl = t;
  for (const run of queue.splice(0)) run(t);
}

export const later = (run: (t: Impl) => void) => {
  if (impl) run(impl);
  else queue.push(run);
};
