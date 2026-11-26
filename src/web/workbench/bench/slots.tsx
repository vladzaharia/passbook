import { createContext, type ReactNode, useContext } from 'react';
import { createPortal } from 'react-dom';

/** The frame's slots a tool fills (bench/frame.tsx on the docs pages, `ToolPage` in the Workbench). */
export type BenchSlotName = 'action' | 'count' | 'toolbar' | 'status';

/** The slot elements a `ToolPage` drew: null until each is mounted, so a tool waits for its slot. */
export type BenchSlots = Partial<Record<BenchSlotName, HTMLElement | null>>;
export const BenchSlotsContext = createContext<BenchSlots | null>(null);

const find = (name: BenchSlotName): HTMLElement | null =>
  typeof document === 'undefined' ? null : document.querySelector(`[data-bench-${name}]`);

/**
 * Draws `children` into the frame's slot: the primary action and the count in the title row, the
 * toolbar, the live mark. A Workbench `ToolPage` supplies the slots through context; a docs frame is
 * found in the page; outside both (a test) they draw in place.
 */
export function BenchSlot({ name, children }: { name: BenchSlotName; children: ReactNode }) {
  const slots = useContext(BenchSlotsContext);
  if (slots) {
    const slot = slots[name];
    return slot ? createPortal(children, slot) : null;
  }
  const el = find(name);
  return el ? createPortal(children, el) : children;
}
