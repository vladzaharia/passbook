import { useEffect, useSyncExternalStore } from 'react';

// Page buddies (Buddy, Cameo) mounted now. One buddy per view: the toaster shows a check while > 0.
let count = 0;
const subs = new Set<() => void>();
const emit = () => {
  for (const sub of subs) sub();
};
const subscribe = (sub: () => void) => {
  subs.add(sub);
  return () => subs.delete(sub);
};

export function useRegisterBuddy(): void {
  useEffect(() => {
    count++;
    emit();
    return () => {
      count--;
      emit();
    };
  }, []);
}

export const useBuddyOnScreen = (): boolean =>
  useSyncExternalStore(
    subscribe,
    () => count > 0,
    () => false,
  );
