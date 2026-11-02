import type { z } from 'zod';
import { PreviewBatchSchema, type PreviewResponseSchema } from '@/shared/contracts/templates.ts';
import { api } from './api.ts';
import { ApiError } from './errors.ts';

type Preview = z.infer<typeof PreviewResponseSchema>;
type Waiter = { resolve: (p: Preview) => void; reject: (e: unknown) => void };

const WINDOW_MS = 8;
const MAX_IDS = 50;
let waiting = new Map<string, Waiter[]>();
let timer: ReturnType<typeof setTimeout> | undefined;

async function flush(): Promise<void> {
  const batch = waiting;
  waiting = new Map();
  timer = undefined;
  const ids = [...batch.keys()];
  for (let i = 0; i < ids.length; i += MAX_IDS) {
    const slice = ids.slice(i, i + MAX_IDS);
    try {
      const { items } = await api.get('/api/v1/templates/previews', PreviewBatchSchema, {
        query: { ids: slice.join(',') },
      });
      const byId = new Map(items.map((item) => [item.id, item]));
      for (const id of slice) {
        const item = byId.get(id);
        for (const w of batch.get(id) ?? [])
          if (item) w.resolve(item);
          else w.reject(new ApiError({ status: 404, code: 'TEMPLATE_NOT_FOUND' }));
      }
    } catch (error) {
      for (const id of slice) for (const w of batch.get(id) ?? []) w.reject(error);
    }
  }
}

/**
 * Default-sample preview of one template. Calls made within a few milliseconds of each other
 * (a gallery, a list's swatches) share one request.
 */
export function fetchPreview(id: string): Promise<Preview> {
  return new Promise((resolve, reject) => {
    waiting.set(id, [...(waiting.get(id) ?? []), { resolve, reject }]);
    if (timer === undefined) timer = setTimeout(() => void flush(), WINDOW_MS);
  });
}
