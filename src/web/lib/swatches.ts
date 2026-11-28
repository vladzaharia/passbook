import { useQueries } from '@tanstack/react-query';
import { assetUrlMap } from '../pass-card/assets.ts';
import { fetchPreview, templatePreviewKey } from './preview-batch.ts';

/** A pass's look in miniature: its colours and the image Wallet shows largest. */
export interface Swatch {
  background: string;
  foreground: string;
  label?: string;
  /** Artwork, background, strip or thumbnail, in that order, when the template has one. */
  image?: string;
}

const IMAGES = ['artwork@2x.png', 'background@2x.png', 'strip@2x.png', 'thumbnail@2x.png'];

/** Template previews (batched into one request) give rows their pass look, cached for the session. */
export function useSwatches(
  templateIds: readonly string[],
  orgId: string | undefined,
  /** The All scope: each template's own organization. */
  orgByTemplate?: ReadonlyMap<string, string>,
): Map<string, Swatch> {
  return useQueries({
    queries: templateIds.map((id) => {
      const org = orgByTemplate?.get(id) ?? orgId;
      return {
        queryKey: templatePreviewKey(id, org),
        queryFn: () => fetchPreview(id, org),
        staleTime: Number.POSITIVE_INFINITY,
        retry: false,
      };
    }),
    combine: (results) => {
      const map = new Map<string, Swatch>();
      results.forEach((r, i) => {
        const id = templateIds[i];
        const data = r.data;
        const j = data?.passJson as {
          backgroundColor?: unknown;
          foregroundColor?: unknown;
          labelColor?: unknown;
        };
        if (!id || !data || typeof j?.backgroundColor !== 'string') return;
        const name = IMAGES.find((n) => data.assetNames.includes(n));
        map.set(id, {
          background: j.backgroundColor,
          foreground: typeof j.foregroundColor === 'string' ? j.foregroundColor : '#fff',
          ...(typeof j.labelColor === 'string' ? { label: j.labelColor } : {}),
          ...(name ? { image: assetUrlMap(data.assetBaseUrl, [name])[name] } : {}),
        });
      });
      return map;
    },
  });
}
