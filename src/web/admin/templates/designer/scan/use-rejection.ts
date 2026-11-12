import { useState } from 'react';
import { textRejection } from './scan-preview-policy.ts';

/** A refused edit keeps the field as it was and says why, until the next accepted edit or blur. */
export function useRejection(plain = false) {
  const [refused, setRefused] = useState<{ at: number; why: string } | undefined>();
  return {
    error: refused?.why,
    /** The reason, only for the field at `at`. */
    errorAt: (at: number) => (refused?.at === at ? refused.why : undefined),
    clear: () => setRefused(undefined),
    /** True when the text may be stored; otherwise records the reason. */
    accept: (text: string, at = 0, also: string | null = null): boolean => {
      const why = textRejection(text, plain) ?? also;
      setRefused(why ? { at, why } : undefined);
      return !why;
    },
  };
}
