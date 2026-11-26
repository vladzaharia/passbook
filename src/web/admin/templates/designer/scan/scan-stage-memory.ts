import { useCallback, useState } from 'react';

const memory = new Map<string, unknown>();

/**
 * A stage setting that survives the stage being rebuilt (a resize across the phone breakpoint, a
 * device turning) while the designer stays open. One value per template and name; gone on reload.
 */
export function useRemembered<T>(
  templateId: string,
  name: string,
  initial: T,
): readonly [T, (next: T) => void] {
  const key = `${templateId}:${name}`;
  const [value, setValue] = useState<T>(() => (memory.has(key) ? (memory.get(key) as T) : initial));
  const set = useCallback(
    (next: T) => {
      memory.set(key, next);
      setValue(next);
    },
    [key],
  );
  return [value, set] as const;
}

/** Tests: each starts from the defaults. */
export const forgetStageMemory = () => memory.clear();
