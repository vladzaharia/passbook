import { useState } from 'react';

type KeyedItem<T> = { value: T; key: string };
let nextEditorKey = 0;
export const editorKey = () => `scan-field-${++nextEditorKey}`;

function sameEditorValue(a: unknown, b: unknown): boolean {
  if (Object.is(a, b)) return true;
  if (a === null || b === null || typeof a !== 'object' || typeof b !== 'object') return false;
  try {
    return JSON.stringify(a) === JSON.stringify(b);
  } catch {
    return false;
  }
}

/**
 * Authored condition values and text pieces have no IDs. Keep UI-only identities through edits,
 * additions and removals without writing those identities into the authored document.
 */
export function useEditorKeys<T>(values: readonly T[]) {
  const [state, setState] = useState<{
    current: KeyedItem<T>[];
    pending?: KeyedItem<T>[];
  }>(() => ({ current: values.map((value) => ({ value, key: editorKey() })) }));
  const matches = (items: KeyedItem<T>[]) =>
    items.length === values.length &&
    items.every((item, i) => sameEditorValue(item.value, values[i]));
  let current = state.current;
  if (!matches(current)) {
    if (state.pending && matches(state.pending)) {
      current = state.pending;
    } else {
      const used = new Set<number>();
      const next: (KeyedItem<T> | undefined)[] = values.map(() => undefined);
      // Preserve unchanged entries at their existing positions before matching moves or duplicates.
      values.forEach((value, i) => {
        const old = current[i];
        if (old && sameEditorValue(old.value, value)) {
          next[i] = { value, key: old.key };
          used.add(i);
        }
      });
      values.forEach((value, i) => {
        if (next[i]) return;
        const match = current.findIndex(
          (item, j) => !used.has(j) && sameEditorValue(item.value, value),
        );
        if (match >= 0) {
          next[i] = { value, key: current[match]?.key ?? editorKey() };
          used.add(match);
        }
      });
      current = values.map((value, i) => {
        const matched = next[i];
        if (matched) return matched;
        const match = !used.has(i) && current[i] ? i : current.findIndex((_, j) => !used.has(j));
        if (match < 0) return { value, key: editorKey() };
        used.add(match);
        return { value, key: current[match]?.key ?? editorKey() };
      });
    }
    setState({ current });
  }
  const keys = current.map((item) => item.key);
  const remember = (next: readonly T[], nextKeys: readonly string[]) =>
    setState({
      current,
      pending: next.map((value, i) => ({ value, key: nextKeys[i] ?? editorKey() })),
    });
  return {
    keys,
    items: values.map((value, i) => ({ value, key: keys[i] ?? editorKey() })),
    remember,
  };
}
