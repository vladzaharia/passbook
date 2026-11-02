import { useQueries } from '@tanstack/react-query';
import { PreviewResponseSchema } from '@/shared/contracts/templates.ts';
import { assetUrlMap } from '../pass-card/assets.ts';
import { api } from './api.ts';

/** A pass's look in miniature: its colours and the image Wallet shows largest. */
export interface Swatch {
  background: string;
  foreground: string;
  /** Artwork, background, strip or thumbnail, in that order, when the template has one. */
  image?: string;
}

const IMAGES = ['artwork@2x.png', 'background@2x.png', 'strip@2x.png', 'thumbnail@2x.png'];

/** One template preview per template gives rows their pass look (cached for the session). */
export function useSwatches(templateIds: readonly string[]): Map<string, Swatch> {
  return useQueries({
    queries: templateIds.map((id) => ({
      queryKey: ['admin', 'templates', 'preview', id, null],
      queryFn: ({ signal }: { signal: AbortSignal }) =>
        api.post(`/api/v1/templates/${id}/preview`, PreviewResponseSchema, {}, { signal }),
      staleTime: Number.POSITIVE_INFINITY,
      retry: false,
    })),
    combine: (results) => {
      const map = new Map<string, Swatch>();
      results.forEach((r, i) => {
        const id = templateIds[i];
        const data = r.data;
        const j = data?.passJson as { backgroundColor?: unknown; foregroundColor?: unknown };
        if (!id || !data || typeof j?.backgroundColor !== 'string') return;
        const name = IMAGES.find((n) => data.assetNames.includes(n));
        map.set(id, {
          background: j.backgroundColor,
          foreground: typeof j.foregroundColor === 'string' ? j.foregroundColor : '#fff',
          ...(name ? { image: assetUrlMap(data.assetBaseUrl, [name])[name] } : {}),
        });
      });
      return map;
    },
  });
}
