import { applyOp, type Op } from './apply.ts';
import { allKeys, type DesignDoc, type Selection } from './model.ts';
import { uniqueKey } from './ops-pass.ts';

const LIMIT = 100;
/** Edits of the same thing within this many ms are one undo step (typing). */
const COALESCE_MS = 1000;

export interface DesignerState {
  doc: DesignDoc;
  past: DesignDoc[];
  future: DesignDoc[];
  /** What was last saved (or loaded); the unsaved check compares against it. */
  saved: DesignDoc;
  select: Selection;
  /** Set by an add, so the new row can take focus and play its entrance. */
  added: { kind: 'field' | 'input'; key: string; n: number } | null;
  merge: { key: string; at: number } | null;
}

export type Action =
  | { type: 'edit'; op: Op; merge?: string; at?: number }
  | { type: 'undo' }
  | { type: 'redo' }
  | { type: 'select'; select: Selection }
  | { type: 'saved'; doc: DesignDoc }
  | { type: 'reset'; doc: DesignDoc };

export function initialState(doc: DesignDoc, saved: DesignDoc = doc): DesignerState {
  return {
    doc,
    past: [],
    future: [],
    saved,
    select: { section: 'style' },
    added: null,
    merge: null,
  };
}

export function designerReducer(state: DesignerState, action: Action): DesignerState {
  switch (action.type) {
    case 'edit': {
      let op = action.op;
      // The key of a new field is fixed here, so replaying the op gives the same document.
      if (op.op === 'field-add' && !op.key) op = { ...op, key: uniqueKey(state.doc.passJson) };
      const doc = applyOp(state.doc, op);
      if (doc === state.doc) return state;
      const at = action.at ?? 0;
      const joins =
        action.merge !== undefined &&
        state.merge?.key === action.merge &&
        at - state.merge.at < COALESCE_MS &&
        state.past.length > 0;
      const past = joins ? state.past : [...state.past, state.doc].slice(-LIMIT);
      const added =
        op.op === 'field-add' && op.key
          ? { kind: 'field' as const, key: op.key, n: (state.added?.n ?? 0) + 1 }
          : op.op === 'input-add'
            ? { kind: 'input' as const, key: op.spec.name, n: (state.added?.n ?? 0) + 1 }
            : state.added;
      // A renamed field or input keeps the selection.
      const renamed =
        op.op === 'field-key' && state.select.key === op.key
          ? op.to
          : op.op === 'input-set' && op.patch.name && state.select.key === op.name
            ? op.patch.name
            : undefined;
      return {
        ...state,
        doc,
        past,
        future: [],
        select: renamed ? { ...state.select, key: renamed } : state.select,
        added,
        merge: action.merge !== undefined ? { key: action.merge, at } : null,
      };
    }
    case 'undo': {
      const previous = state.past.at(-1);
      if (!previous) return state;
      return {
        ...state,
        doc: previous,
        past: state.past.slice(0, -1),
        future: [state.doc, ...state.future],
        merge: null,
      };
    }
    case 'redo': {
      const [next, ...future] = state.future;
      if (!next) return state;
      return { ...state, doc: next, past: [...state.past, state.doc], future, merge: null };
    }
    case 'select':
      return { ...state, select: action.select };
    case 'saved':
      return { ...state, saved: action.doc, merge: null };
    case 'reset':
      return initialState(action.doc);
  }
}

/** Signature of a document for the unsaved check. Uploads count by length and tail. */
export function signature(doc: DesignDoc): string {
  return JSON.stringify([
    doc.passJson,
    doc.manifest,
    doc.assets.map((a) =>
      a.upload !== undefined ? [a.name, a.upload.length, a.upload.slice(-24)] : [a.name, a.sha1],
    ),
  ]);
}

export function isDirty(state: DesignerState): boolean {
  return state.doc !== state.saved && signature(state.doc) !== signature(state.saved);
}

export const canUndo = (s: DesignerState): boolean => s.past.length > 0;
export const canRedo = (s: DesignerState): boolean => s.future.length > 0;

/** Keeps the selection pointing at something that exists after an edit or undo. */
export function validSelection(state: DesignerState): Selection {
  const { select, doc } = state;
  if (
    select.section.endsWith('Fields') &&
    select.key &&
    !allKeys(doc.passJson).includes(select.key)
  )
    return { section: select.section };
  return select;
}
