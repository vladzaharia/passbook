import { DRAFT_PREFIX as PREFIX } from '../../../lib/local-drafts.ts';
import { type DesignDoc, isRecord } from './model.ts';

/** One draft per person, organisation and template. */
export const draftKey = (userId: string, orgId: string | null, key: string): string =>
  `${userId}:${orgId ?? 'platform'}:${key}`;
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

export function loadDraft(key: string): Draft | null {
  try {
    const raw = storage()?.getItem(PREFIX + key);
    if (!raw) return null;
    const draft: unknown = JSON.parse(raw);
    if (!isRecord(draft) || typeof draft.base !== 'string' || !isRecord(draft.doc)) return null;
    const { passJson, manifest, assets } = draft.doc;
    if (!isRecord(passJson) || !isRecord(manifest) || !Array.isArray(assets)) return null;
    if (!assets.every((a) => isRecord(a) && typeof a.name === 'string')) return null;
    return draft as unknown as Draft;
  } catch {
    return null;
  }
}

/** Returns false when the draft does not fit or the browser refuses it. */
export function saveDraft(key: string, draft: Draft): boolean {
  try {
    const store = storage();
    const text = JSON.stringify(draft);
    if (!store || text.length > MAX_CHARS) return false;
    store.setItem(PREFIX + key, text);
    return true;
  } catch {
    return false;
  }
}

export function clearDraft(key: string): void {
  try {
    storage()?.removeItem(PREFIX + key);
  } catch {
    // Nothing to clear when storage is blocked.
  }
}
