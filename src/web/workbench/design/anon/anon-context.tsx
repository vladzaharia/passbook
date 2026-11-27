import { createContext, useContext } from 'react';
import type { InputMode } from '../../playground/hash.ts';
import type { InputValues } from '../../playground/model.ts';
import type { AnonBlueprint } from './blueprint.ts';

/** What the signed-out page edits around the read-only core: the sample's values, and the blueprint. */
export interface AnonValue {
  blueprint: AnonBlueprint;
  values: InputValues;
  mode: InputMode;
  setValues: (next: InputValues) => void;
  setMode: (mode: InputMode) => void;
  /** All blueprints, for the picker. */
  options: readonly { value: string; label: string }[];
  pick: (id: string) => void;
  save: () => void;
  share: () => void;
}

const AnonContext = createContext<AnonValue | null>(null);

export const AnonProvider = AnonContext.Provider;

export function useAnon(): AnonValue {
  const value = useContext(AnonContext);
  if (!value) throw new Error('useAnon outside the signed-out Design page.');
  return value;
}
