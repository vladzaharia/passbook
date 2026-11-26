import { MemberPhotoSchema } from '@/shared/contracts/check-in.ts';
import { PhotoMatchResponseSchema } from '@/shared/contracts/photo-import.ts';
import { api } from '../../../lib/api.ts';
import { errorMessage } from '../../../lib/errors.ts';
import { memberPhotoPng } from '../member-photo-file.ts';

export type Entry = {
  id: number;
  file: File;
  /** The file name without its extension: an External ID or a serial. */
  key: string;
  state: 'matching' | 'matched' | 'none' | 'ambiguous' | 'uploading' | 'done' | 'failed';
  passId?: string;
  error?: string;
};

export const keyOf = (name: string) => name.replace(/\.[^.]+$/, '').trim();

/** Two files with one name would write one pass twice: the later one is refused up front. */
export function entriesOf(files: File[]): Entry[] {
  const seen = new Set<string>();
  return files.map((file, id) => {
    const key = keyOf(file.name);
    const duplicate = seen.has(key);
    seen.add(key);
    return duplicate
      ? { id, file, key, state: 'failed', error: 'Another file has this name.' }
      : { id, file, key, state: 'matching' };
  });
}

export async function matchEntries(
  orgId: string,
  entries: Entry[],
  onProgress?: (done: number) => void,
): Promise<Entry[]> {
  const out = [...entries];
  const open = out.filter((e) => e.state === 'matching');
  for (let at = 0; at < open.length; at += 200) {
    const chunk = open.slice(at, at + 200);
    const { matches } = await api.post('/api/v1/passes/photos/match', PhotoMatchResponseSchema, {
      orgId,
      keys: chunk.map((e) => e.key),
    });
    for (const m of matches) {
      const index = out.findIndex((e) => e.state === 'matching' && e.key === m.key);
      const entry = out[index];
      if (entry)
        out[index] = { ...entry, state: m.state, ...(m.passId ? { passId: m.passId } : {}) };
    }
    onProgress?.(Math.min(open.length, at + chunk.length));
  }
  return out;
}

/** One photo: the same crop, re-encode and upload as the pass page. */
export async function uploadEntry(entry: Entry, includeInPass: boolean): Promise<Entry> {
  try {
    const png = await memberPhotoPng(entry.file);
    await api.put(`/api/v1/passes/${entry.passId}/member-photo`, MemberPhotoSchema, {
      png,
      includeInPass,
    });
    return { ...entry, state: 'done' };
  } catch (error) {
    return { ...entry, state: 'failed', error: errorMessage(error) };
  }
}
