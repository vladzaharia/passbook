import { useEffect, useState } from 'react';
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
  useEffect(() => {
    toggle = () => setOpen((o) => !o);
  }, []);
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
