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
  useEffect(() => {
    if (open) return;
    const t = setTimeout(() => {
      if (document.activeElement && document.activeElement !== document.body) return;
      const back =
        from.current?.isConnected && from.current !== document.body ? from.current : null;
      (back ?? document.querySelector<HTMLElement>('[data-search]'))?.focus();
    }, 0);
    return () => clearTimeout(t);
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
