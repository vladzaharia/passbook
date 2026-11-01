import { createContext, useContext } from 'react';

/** Opens the admin command palette; null outside the admin shell. */
export const PaletteContext = createContext<{ open: () => void } | null>(null);
export const usePalette = () => useContext(PaletteContext);
