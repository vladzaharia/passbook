import { type Dispatch, type SetStateAction, useState } from 'react';
import type { ChannelEdits } from './channels-panel.tsx';

/**
 * The Channels tab's unsaved choices, kept by the page that hosts it: a layout switch remounts the
 * tab and would drop them. A new `key` (another org, mode or template) starts empty.
 */
export function useChannelDraft(
  key: string,
): [ChannelEdits, Dispatch<SetStateAction<ChannelEdits>>] {
  const [draft, setDraft] = useState<{ key: string; edits: ChannelEdits }>({ key, edits: {} });
  const edits = draft.key === key ? draft.edits : {};
  const set: Dispatch<SetStateAction<ChannelEdits>> = (next) =>
    setDraft((d) => {
      const base = d.key === key ? d.edits : {};
      return { key, edits: typeof next === 'function' ? next(base) : next };
    });
  return [edits, set];
}
