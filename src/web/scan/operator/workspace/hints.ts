import { viewKeys } from '../keys.ts';
import type { KeyHint } from './status-bar.tsx';

/** The keys that do something right now, for the status bar. */
export function hintsOf(f: {
  searching: boolean;
  record: boolean;
  undoable: boolean;
  views: number;
  rollCall?: boolean;
}): KeyHint[] {
  if (f.searching)
    return [
      { keys: '↑↓', label: 'Move' },
      { keys: '↵', label: 'Open' },
      { keys: 'Esc', label: 'Clear' },
    ];
  const hints: KeyHint[] = [{ keys: '/', label: 'Search' }];
  if (f.record && f.rollCall)
    hints.push(
      { keys: 'S', label: 'Safe' },
      { keys: 'X', label: 'Out' },
      { keys: 'Esc', label: 'Close' },
    );
  else if (f.record) hints.push({ keys: '↵', label: 'Primary' }, { keys: 'Esc', label: 'Close' });
  if (f.undoable) hints.push({ keys: '⌘Z', label: 'Undo last' });
  if (f.views > 1) hints.push({ keys: viewKeys(f.views), label: 'Lists' });
  hints.push({ keys: '?', label: 'Shortcuts' });
  return hints;
}
