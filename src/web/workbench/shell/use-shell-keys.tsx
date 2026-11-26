import { useEffect, useRef, useState } from 'react';
import { WB_SHELL_COPY } from '@/shared/copy/workbench-shell.ts';
import type { WbTool } from '@/shared/workbench.ts';
import { useAnnounce } from './announcer.tsx';
import { CHORD_MS, GO_CHORD, resolveShellKey } from './keys.ts';

/** An open modal layer owns the keyboard: a dialog, a sheet or a menu. */
function layerOpen(): boolean {
  return (
    document.querySelector(
      '[role="dialog"][data-state="open"], [role="menu"][data-state="open"]',
    ) !== null
  );
}

/**
 * The shell's keys (design §5.4): `g` + a letter opens an area, `?` and ⌘/ the shortcuts sheet.
 * A `g` waits 1.2 s for its second key, shows its hint and says it once. Off, single keys stop.
 * Returns whether the chord hint shows.
 */
export function useShellKeys({
  singleKeys,
  onGo,
  onHelp,
}: {
  singleKeys: boolean;
  onGo: (tool: WbTool) => void;
  onHelp: () => void;
}): boolean {
  const announce = useAnnounce();
  const [hint, setHint] = useState(false);
  const latest = useRef({ singleKeys, onGo, onHelp, announce });
  latest.current = { singleKeys, onGo, onHelp, announce };
  useEffect(() => {
    let chord = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const end = () => {
      chord = false;
      setHint(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.defaultPrevented || e.repeat) return;
      const { singleKeys: on, onGo: go, onHelp: help, announce: say } = latest.current;
      const next = resolveShellKey(e, { chord, singleKeys: on, layerOpen: layerOpen() });
      clearTimeout(timer);
      chord = next.chord;
      setHint(next.chord);
      if (next.chord) timer = setTimeout(end, CHORD_MS);
      const action = next.action;
      if (!action) return;
      e.preventDefault();
      if (action.kind === 'chord') say(WB_SHELL_COPY.chordHint, { clearAfter: CHORD_MS });
      else if (action.kind === 'help') help();
      else go(action.tool);
    };
    addEventListener('keydown', onKey);
    return () => {
      clearTimeout(timer);
      removeEventListener('keydown', onKey);
    };
  }, []);
  return hint;
}

/** The waiting `g`: a key cap at the foot of the screen for its 1.2 s. */
export function ChordHint({ tools }: { tools: readonly WbTool[] }) {
  const letters = tools.map((t) => GO_CHORD[t].slice(2)).join(' ');
  return (
    <div
      aria-hidden
      className="wb-chord pointer-events-none fixed bottom-[max(1.5rem,env(safe-area-inset-bottom))] left-1/2 z-50 flex -translate-x-1/2 items-center gap-2 rounded-lg border border-border bg-surface-overlay px-3 py-2 text-sm text-fg-muted shadow-elevation-3"
    >
      <kbd className="rounded-sm border border-border-strong bg-surface-raised px-1.5 font-mono text-xs text-fg-strong">
        g
      </kbd>
      <span>{WB_SHELL_COPY.chordHint}</span>
      <span className="font-mono text-xs tracking-wide">{letters}</span>
    </div>
  );
}
