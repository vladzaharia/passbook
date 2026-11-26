import { createRoot } from 'react-dom/client';
import { useActiveOperation } from '../../ui/operation/use-operation.ts';
import { loadSession, onSession, type Session } from '../console/session.ts';
import type { Island } from '../shell/islands.ts';
import { type ChipState, SandboxChip } from './sandbox-chip.tsx';
import { BenchKeys } from './shortcuts.tsx';
import { ContextStrip, type StripModel, stripModel } from './strip.tsx';
import type { BenchTool } from './switcher.tsx';
import './bench-chip.css';

type Ready = Extract<StripModel, { kind: 'ready' }>;

/** The strip of a sandbox in use: an operation running on it (OP-2) rings the chip and leads its menu. */
function ReadyStrip({ tool, model }: { tool: BenchTool; model: Ready }) {
  const op = useActiveOperation({ type: 'sandbox', id: model.orgId });
  return (
    <ContextStrip
      tool={tool}
      model={model}
      activity={op ? { title: op.title, text: op.text } : undefined}
    />
  );
}

/** The `bench-strip` island: the strip for the tool its placeholder names, redrawn when the session changes. */
export const stripIsland: Island = {
  mount: async (el) => {
    const tool = (el.dataset.tool ?? 'console') as BenchTool;
    const root = createRoot(el);
    const paint = async () => {
      const model = await stripModel(tool);
      root.render(
        <>
          {model.kind === 'ready' ? (
            <ReadyStrip tool={tool} model={model} />
          ) : (
            <ContextStrip tool={tool} model={model} />
          )}
          <BenchKeys tool={tool} />
        </>,
      );
    };
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
