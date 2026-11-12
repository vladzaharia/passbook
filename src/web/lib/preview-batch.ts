import type { z } from 'zod';
import { PreviewBatchSchema, type PreviewResponseSchema } from '@/shared/contracts/templates.ts';
import { api } from './api.ts';
import { ApiError } from './errors.ts';

type Preview = z.infer<typeof PreviewResponseSchema>;
type Waiter = { resolve: (p: Preview) => void; reject: (e: unknown) => void };
type Batch = {
  orgId: string | undefined;
  waiters: Map<string, Waiter[]>;
  controller: AbortController;
};

const WINDOW_MS = 8;
const MAX_IDS = 50;
export const templatePreviewKey = (id: string, orgId: string | undefined, version?: string) =>
  ['admin', 'templates', 'preview', id, orgId ?? null, version ?? null] as const;

/** Scope asset requests to the same org as their preview, retaining any existing URL suffix. */
export function scopePreviewAssets(preview: Preview, orgId: string | undefined): Preview {
  if (orgId === undefined) return preview;
  const hashAt = preview.assetBaseUrl.indexOf('#');
  const beforeHash = hashAt === -1 ? preview.assetBaseUrl : preview.assetBaseUrl.slice(0, hashAt);
  const hash = hashAt === -1 ? '' : preview.assetBaseUrl.slice(hashAt);
  const queryAt = beforeHash.indexOf('?');
  const path = queryAt === -1 ? beforeHash : beforeHash.slice(0, queryAt);
  const params = new URLSearchParams(queryAt === -1 ? '' : beforeHash.slice(queryAt + 1));
  params.set('orgId', orgId);
  return { ...preview, assetBaseUrl: `${path}?${params.toString()}${hash}` };
}

let waiting = new Map<string | undefined, Batch>();
const active = new Set<Batch>();
let timer: ReturnType<typeof setTimeout> | undefined;

function cancelBatch(batch: Batch): void {
  batch.controller.abort();
  const error = new DOMException('Preview request cancelled', 'AbortError');
  for (const waiters of batch.waiters.values()) for (const waiter of waiters) waiter.reject(error);
  batch.waiters.clear();
}

/** Cancel queued and in-flight previews for a workspace that has been left. */
export function clearOrgPreviewBatches(orgId: string): void {
  const queued = waiting.get(orgId);
  if (queued) {
    waiting.delete(orgId);
    cancelBatch(queued);
  }
  for (const batch of active) {
    if (batch.orgId === orgId) {
      cancelBatch(batch);
      active.delete(batch);
    }
  }
  if (waiting.size === 0 && timer !== undefined) {
    clearTimeout(timer);
    timer = undefined;
  }
}

/** Cancel all outstanding previews before a principal change or sign-out. */
export function clearPreviewBatches(): void {
  clearTimeout(timer);
  timer = undefined;
  for (const batch of waiting.values()) cancelBatch(batch);
  waiting = new Map();
  for (const batch of active) cancelBatch(batch);
  active.clear();
}

async function flushOrg(batch: Batch): Promise<void> {
  const { orgId, waiters, controller } = batch;
  const ids = [...waiters.keys()];
  try {
    for (let i = 0; i < ids.length && !controller.signal.aborted; i += MAX_IDS) {
      const slice = ids.slice(i, i + MAX_IDS);
      try {
        const { items } = await api.get('/api/v1/templates/previews', PreviewBatchSchema, {
          query: { ids: slice.join(','), orgId },
          signal: controller.signal,
        });
        if (controller.signal.aborted) return;
        const byId = new Map(items.map((item) => [item.id, item]));
        for (const id of slice) {
          const found = byId.get(id);
          const item = found ? scopePreviewAssets(found, orgId) : undefined;
          const requests = waiters.get(id) ?? [];
          waiters.delete(id);
          for (const waiter of requests)
            if (item) waiter.resolve(item);
            else waiter.reject(new ApiError({ status: 404, code: 'TEMPLATE_NOT_FOUND' }));
        }
      } catch (error) {
        if (controller.signal.aborted) return;
        for (const id of slice) {
          const requests = waiters.get(id) ?? [];
          waiters.delete(id);
          for (const waiter of requests) waiter.reject(error);
        }
      }
    }
  } finally {
    active.delete(batch);
  }
}

function flush(): void {
  const batches = waiting;
  waiting = new Map();
  timer = undefined;
  for (const batch of batches.values()) {
    active.add(batch);
    void flushOrg(batch);
  }
}

/**
 * Default-sample previews share a request only within the same organization. An undefined
 * organization is reserved for an explicitly global preview.
 */
export function fetchPreview(id: string, orgId: string | undefined): Promise<Preview> {
  return new Promise((resolve, reject) => {
    let batch = waiting.get(orgId);
    if (!batch) {
      batch = { orgId, waiters: new Map(), controller: new AbortController() };
      waiting.set(orgId, batch);
    }
    const requests = batch.waiters.get(id);
    if (requests) requests.push({ resolve, reject });
    else batch.waiters.set(id, [{ resolve, reject }]);
    if (timer === undefined) timer = setTimeout(flush, WINDOW_MS);
  });
}
