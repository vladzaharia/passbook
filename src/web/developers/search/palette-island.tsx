import { useEffect, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import '../../ui/art/scenes/common.css';
import '../../ui/art/scenes/plug.css';
import '../../../generated/search-kit.css';
import './search.css';
import { SearchPalette } from './palette.tsx';

let toggle: (() => void) | null = null;

/** Mounted by the first ⌘K, so it starts open. */
function Host() {
  const [open, setOpen] = useState(true);
  const from = useRef<HTMLElement | null>(null);
  useEffect(() => {
    toggle = () => {
      if (document.activeElement instanceof HTMLElement) from.current = document.activeElement;
      setOpen((o) => !o);
    };
  }, []);
  // Closing hands focus back to where it was; opened from the page body (⌘K, "/"), that is the Search button.
  // The dialog leaves the DOM after its exit animation, so wait for that before looking at focus.
  useEffect(() => {
    if (open) return;
    const timer = setInterval(() => {
      if (document.querySelector('[role="dialog"]')) return;
      clearInterval(timer);
      if (document.activeElement && document.activeElement !== document.body) return;
      const back =
        from.current?.isConnected && from.current !== document.body ? from.current : null;
      // The menubar renders two Search buttons (icon and field); only one is displayed.
      const shown = [...document.querySelectorAll<HTMLElement>('[data-search]')].find(
        (el) => el.getClientRects().length > 0,
      );
      (back ?? shown)?.focus();
    }, 30);
    return () => clearInterval(timer);
  }, [open]);
  return <SearchPalette open={open} onOpenChange={setOpen} />;
}

/** Opens the palette, or closes it when it is open. The first call mounts it. */
export function toggleSearch(): void {
  if (!toggle) {
    const root = document.createElement('div');
    document.body.append(root);
    createRoot(root).render(<Host />);
    return;
  }
  toggle();
}
