import { type KeyboardEvent, useRef } from 'react';
import type { TreeRow } from './tree-model.ts';

export interface TreeKeys {
  rows: readonly TreeRow[];
  focus: string;
  open: ReadonlySet<string>;
  setFocus: (pointer: string) => void;
  setOpen: (pointer: string, open: boolean) => void;
  /** Enter: the node's default action. */
  activate: (row: TreeRow) => void;
  /** Shift+F10: move to the node's actions. */
  actions: (row: TreeRow) => void;
}

const TYPEAHEAD_MS = 700;

/** The WAI-ARIA tree keys: arrows, Home and End, first-letter typeahead, Enter, Shift+F10. */
export function useTreeKeys(t: TreeKeys) {
  const typed = useRef({ text: '', at: 0 });
  return (e: KeyboardEvent) => {
    if (e.altKey || e.ctrlKey || e.metaKey) return;
    const at = t.rows.findIndex((r) => r.pointer === t.focus);
    const row = t.rows[at];
    if (!row) return;
    const go = (i: number) => {
      const to = t.rows[Math.max(0, Math.min(t.rows.length - 1, i))];
      if (to) t.setFocus(to.pointer);
    };
    const isOpen = t.open.has(row.pointer);
    switch (e.key) {
      case 'ArrowDown':
        go(at + 1);
        break;
      case 'ArrowUp':
        go(at - 1);
        break;
      case 'Home':
        go(0);
        break;
      case 'End':
        go(t.rows.length - 1);
        break;
      case 'ArrowRight':
        if (!row.expandable) return;
        if (!isOpen) t.setOpen(row.pointer, true);
        else go(at + 1);
        break;
      case 'ArrowLeft':
        if (row.expandable && isOpen) t.setOpen(row.pointer, false);
        else if (row.parent !== null) t.setFocus(row.parent);
        break;
      case 'Enter':
        t.activate(row);
        break;
      case 'F10':
        if (!e.shiftKey) return;
        t.actions(row);
        break;
      default: {
        if (e.key.length !== 1 || e.key === ' ') return;
        const now = Date.now();
        const ty = typed.current;
        ty.text = now - ty.at > TYPEAHEAD_MS ? e.key : ty.text + e.key;
        ty.at = now;
        const q = ty.text.toLowerCase();
        const order = [...t.rows.slice(at + (ty.text.length > 1 ? 0 : 1)), ...t.rows.slice(0, at)];
        const hit = order.find((r) => r.key.toLowerCase().startsWith(q));
        if (hit) t.setFocus(hit.pointer);
        break;
      }
    }
    e.preventDefault();
  };
}
