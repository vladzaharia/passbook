import { createRoot } from 'react-dom/client';
import { loadSession, onSession, type Session } from '../console/session.ts';
import type { Island } from '../shell/islands.ts';
import { type ChipState, SandboxChip } from './sandbox-chip.tsx';
import { ContextStrip, stripModel } from './strip.tsx';
import type { BenchTool } from './switcher.tsx';
import './bench-chip.css';

/** The `bench-strip` island: the strip for the tool its placeholder names, redrawn when the session changes. */
export const stripIsland: Island = {
  mount: async (el) => {
    const tool = (el.dataset.tool ?? 'console') as BenchTool;
    const root = createRoot(el);
    const paint = async () =>
      root.render(<ContextStrip tool={tool} model={await stripModel(tool)} />);
    await paint();
    onSession(() => void paint());
  },
};

const chipState = (session: Session): ChipState | null => {
  if (session.kind === 'ready') return { kind: 'ready', slug: session.sandbox.orgSlug };
  if (session.kind === 'none' || session.kind === 'closed') return { kind: session.kind };
  // Signed out, or the sandbox did not read: the page says which; the bar says nothing.
  return null;
};

/** The `org-chip` island: the top bar's sandbox chip on docs pages (the Workbench's strip carries it on tool pages). */
export const barChipIsland: Island = {
  mount: async (el) => {
    let root: ReturnType<typeof createRoot> | null = null;
    const show = (session: Session) => {
      const state = chipState(session);
      // An empty placeholder is never in view, so the slot is only hidden once the island found no chip.
      el.hidden = state === null;
      if (!state) return;
      root ??= createRoot(el);
      root.render(<SandboxChip variant="bar" state={state} />);
    };
    show(await loadSession());
    onSession(show);
  },
};
