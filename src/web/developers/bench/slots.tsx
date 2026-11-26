import type { ReactNode } from 'react';
import { createPortal } from 'react-dom';

/** The frame's slots a tool fills from its island (bench/frame.tsx). */
export type BenchSlotName = 'action' | 'count' | 'toolbar' | 'status';

const find = (name: BenchSlotName): HTMLElement | null =>
  typeof document === 'undefined' ? null : document.querySelector(`[data-bench-${name}]`);

/**
 * Draws `children` into the frame's slot: the primary action and the count in the title row, the
 * toolbar, the live mark in the strip. Outside the frame (a test, a page without it) they draw in place.
 */
export function BenchSlot({ name, children }: { name: BenchSlotName; children: ReactNode }) {
  const el = find(name);
  return el ? createPortal(children, el) : children;
}
