import { type KeyboardEvent, useEffect, useRef } from 'react';
import { findField, type Selection } from './model.ts';
import type { Action, DesignerState } from './reducer.ts';

/** A new field opens its editor and takes focus, once per add. */
export function useFocusOnAdd(state: DesignerState, focusTarget: (select: Selection) => void) {
  const handled = useRef(0);
  const added = state.added;
  useEffect(() => {
    if (!added || added.n === handled.current) return;
    handled.current = added.n;
    if (added.kind === 'input') return focusTarget({ section: 'inputs', key: added.key });
    const at = findField(state.doc.passJson, added.key, state.doc.target);
    if (at) focusTarget({ section: at.group, key: added.key });
  }, [added, state.doc.passJson, state.doc.target, focusTarget]);
}

/** Undo and redo for the whole designer; off where nothing can change. */
export function undoKeys(off: boolean, dispatch: (action: Action) => void) {
  return (e: KeyboardEvent) => {
    if (off) return;
    if (!(e.metaKey || e.ctrlKey) || e.altKey) return;
    const k = e.key.toLowerCase();
    if (k !== 'z' && k !== 'y') return;
    e.preventDefault(); // Text fields share the designer's history: one undo model, not a browser one per field.
    dispatch({ type: k === 'y' || e.shiftKey ? 'redo' : 'undo' });
  };
}
