import { useEffect, useState } from 'react';
import type { ScanDisplay } from '@/shared/contracts/scan-display.ts';
import { type Box, boxOf, collectTargets, type PreviewTarget } from './scan-targets.ts';

interface Placed {
  target: PreviewTarget;
  box: Box;
}

function place(doc: Document, rendered: ScanDisplay): Placed[] {
  const placed: Placed[] = [];
  for (const target of collectTargets(doc, rendered)) {
    const box = boxOf(target.els);
    if (box) placed.push({ target, box });
  }
  return placed;
}

/** Re-reads the targets whenever the scanner's screen changes or finishes moving. */
function usePlaced(doc: Document | null, rendered: ScanDisplay, key: string): Placed[] {
  const [placed, setPlaced] = useState<Placed[]>([]);
  // biome-ignore lint/correctness/useExhaustiveDependencies: `key` stands for the rendered content
  useEffect(() => {
    if (!doc) return;
    const read = () => setPlaced(place(doc, rendered));
    read();
    const watch = new MutationObserver(read);
    watch.observe(doc.body, { childList: true, subtree: true, characterData: true });
    doc.addEventListener('animationend', read);
    const late = window.setTimeout(read, 700);
    const win = doc.defaultView;
    win?.addEventListener('resize', read);
    return () => {
      watch.disconnect();
      doc.removeEventListener('animationend', read);
      win?.removeEventListener('resize', read);
      window.clearTimeout(late);
    };
  }, [doc, key, rendered]);
  return placed;
}

export interface OverlayState {
  selected: string | null;
  active: string;
  onSelect: (id: string) => void;
  onFocus: (focusKey: string) => void;
}

/**
 * The designer's marks over the scanner's screen: a button per selectable part, and, when asked,
 * a dashed outline on the parts the template cannot change. Nothing here is part of the render.
 */
export function ScanOverlay({
  doc,
  scale,
  rendered,
  contentKey,
  showLocked,
  state,
}: {
  doc: Document | null;
  scale: number;
  rendered: ScanDisplay;
  contentKey: string;
  showLocked: boolean;
  state: OverlayState;
}) {
  const placed = usePlaced(doc, rendered, contentKey);
  return (
    <div className="sp-overlay">
      {placed
        .filter(({ target }) => showLocked || !target.locked)
        .map(({ target, box }) => (
          <button
            key={`${target.focusKey}:${target.id}:${target.label}`}
            type="button"
            className="sp-hit"
            data-locked={target.locked || undefined}
            data-preview-target={target.focusKey}
            data-selection-id={target.id}
            data-selected={(!target.locked && state.selected === target.id) || undefined}
            aria-label={target.label}
            aria-pressed={target.locked ? undefined : state.selected === target.id}
            title={target.locked ? target.label : undefined}
            tabIndex={state.active === target.focusKey ? 0 : -1}
            style={{
              left: box.x * scale,
              top: box.y * scale,
              width: box.w * scale,
              height: box.h * scale,
            }}
            onFocus={() => state.onFocus(target.focusKey)}
            onClick={() => {
              if (!target.locked) state.onSelect(target.id);
            }}
          />
        ))}
    </div>
  );
}
