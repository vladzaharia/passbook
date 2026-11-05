import { createContext, type ReactNode, useContext } from 'react';
import type { Op } from './apply.ts';
import type { DesignDoc, Selection } from './model.ts';
import type { Action, DesignerState } from './reducer.ts';

export interface DesignerApi {
  state: DesignerState;
  doc: DesignDoc;
  /** Applies an edit. `merge` joins quick edits of the same thing into one undo step. */
  edit: (op: Op, merge?: string) => void;
  select: (select: Selection) => void;
  /** Opens a section and moves focus to the control the target names. */
  focusTarget: (select: Selection) => void;
  dispatch: (action: Action) => void;
  /** Mutable assets of the saved version: where to read files that have a hash. */
  assetBase: string;
  /** A template that cannot be changed: edits are ignored and the structure is inert. */
  readOnly: boolean;
}

const Ctx = createContext<DesignerApi | null>(null);

export function DesignerProvider({ value, children }: { value: DesignerApi; children: ReactNode }) {
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useDesigner(): DesignerApi {
  const api = useContext(Ctx);
  if (!api) throw new Error('useDesigner needs a DesignerProvider.');
  return api;
}
