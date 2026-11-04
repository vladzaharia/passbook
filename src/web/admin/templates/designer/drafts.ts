import type { DesignDoc } from './model.ts';

const PREFIX = 'passbook:designer:';
/** localStorage holds about 5 MB per origin; stay well under it. */
const MAX_CHARS = 2_500_000;

export interface Draft {
  /** The saved version this draft started from. */
  base: string;
  doc: DesignDoc;
  at: number;
}

const storage = (): Storage | null => {
  try {
    return typeof localStorage === 'undefined' ? null : localStorage;
  } catch {
    return null;
  }
};

export function loadDraft(templateId: string): Draft | null {
  try {
    const raw = storage()?.getItem(PREFIX + templateId);
    if (!raw) return null;
    const draft = JSON.parse(raw) as Draft;
    return draft && typeof draft.base === 'string' && draft.doc?.passJson && draft.doc.manifest
      ? draft
      : null;
  } catch {
    return null;
  }
}

/** Returns false when the draft does not fit or the browser refuses it. */
export function saveDraft(templateId: string, draft: Draft): boolean {
  try {
    const store = storage();
    const text = JSON.stringify(draft);
    if (!store || text.length > MAX_CHARS) return false;
    store.setItem(PREFIX + templateId, text);
    return true;
  } catch {
    return false;
  }
}

export function clearDraft(templateId: string): void {
  try {
    storage()?.removeItem(PREFIX + templateId);
  } catch {
    // Nothing to clear when storage is blocked.
  }
}
