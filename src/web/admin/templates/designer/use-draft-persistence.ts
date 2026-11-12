import { useEffect, useRef } from 'react';
import { toast } from '../../../ui/index.ts';
import { clearDraft, saveDraft } from './drafts.ts';
import type { DesignDoc } from './model.ts';

/** Keep a dirty draft across reloads, clearing it once local edits are discarded or saved. */
export function useDraftPersistence(
  draftKey: string,
  version: string,
  doc: DesignDoc,
  dirty: boolean,
) {
  // A draft from an older version is offered by the page; it is only cleared once edits were made here.
  const wasDirty = useRef(false);
  const warned = useRef(false);
  useEffect(() => {
    if (!dirty) {
      if (wasDirty.current) clearDraft(draftKey);
      wasDirty.current = false;
      return;
    }
    wasDirty.current = true;
    const t = setTimeout(() => {
      const kept = saveDraft(draftKey, { base: version, doc, at: Date.now() });
      if (!kept && !warned.current) {
        warned.current = true;
        toast.info('This draft is too big to keep. Save a version to keep your work.');
      }
    }, 800);
    return () => clearTimeout(t);
  }, [dirty, doc, draftKey, version]);
}
