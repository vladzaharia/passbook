import { z } from 'zod';
import { api, buildUrl } from '../../../lib/api.ts';
import { toBase64 } from './images.ts';
import type { DraftAsset } from './model.ts';
import { ART_SLOTS, type ArtSlot } from './stamps.ts';

const STAMP_CARD = encodeURIComponent('baked:starter-stamp-card');
const Active = z.object({ activeVersion: z.string().nullable() });

/** The Stamp card's four art files, as new files for the draft. */
export async function fetchBlueprintArt(
  orgId: string | undefined,
): Promise<Partial<Record<ArtSlot, DraftAsset>>> {
  const query = { orgId };
  const { activeVersion } = await api.get(`/api/v1/templates/${STAMP_CARD}`, Active, { query });
  if (!activeVersion) throw new Error('The Stamp card art is not available.');
  const out: Partial<Record<ArtSlot, DraftAsset>> = {};
  await Promise.all(
    ART_SLOTS.map(async ({ slot, file }) => {
      const path = `/api/v1/templates/${STAMP_CARD}/versions/${activeVersion}/assets/${encodeURIComponent(file)}`;
      const res = await fetch(buildUrl(path, query), { credentials: 'same-origin' });
      if (!res.ok) throw new Error('The Stamp card art did not load. Try again.');
      const bytes = new Uint8Array(await res.arrayBuffer());
      out[slot] = {
        name: file,
        slot: 'source',
        scale: 1,
        size: bytes.length,
        upload: toBase64(bytes),
      };
    }),
  );
  return out;
}
