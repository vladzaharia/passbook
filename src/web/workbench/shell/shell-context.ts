import { createContext, useContext } from 'react';
import type { WbTool } from '@/shared/workbench.ts';
import type { WbContext } from '../host/contexts.ts';
import type { AttentionMap } from './attention.ts';

/** What the shell knows that a tool page reads: where it is, what asks for attention, the sheets. */
export interface WbShell {
  context: WbContext | null;
  contexts: readonly WbContext[];
  tool: WbTool | null;
  attention: AttentionMap;
  openShortcuts: () => void;
  openPalette: () => void;
}

export const WbShellContext = createContext<WbShell>({
  context: null,
  contexts: [],
  tool: null,
  attention: {},
  openShortcuts: () => undefined,
  openPalette: () => undefined,
});

export const useWbShell = (): WbShell => useContext(WbShellContext);
