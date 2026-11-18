import type { ScanApi } from '../api/scan-api.ts';
import type { TagsPort } from './types.ts';

/** The assign loop's calls over the scan API client. */
export function tagsPortOf(api: ScanApi): TagsPort {
  return {
    inspect: (body, o) => api.tagInspect(body, o),
    bind: (body, o) => api.tagBind(body, o),
    undo: (id, o) => api.tagUndo(id, o).then(() => undefined),
    pending: (o) => api.tagPending(o).then((r) => r.enrollment),
    complete: (id, body, o) => api.tagComplete(id, body, o),
    decline: (id, o) => api.tagDecline(id, o).then(() => undefined),
  };
}
