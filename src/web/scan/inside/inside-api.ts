import type { ScanApi } from '../api/scan-api.ts';
import type { InsideApiPort } from './inside-types.ts';

/** The real calls behind the list. A mark-out is undone through the ordinary undo route. */
export function insidePort(api: ScanApi): InsideApiPort {
  return {
    inside: (query, call) => api.inside(query, call),
    markOut: (body, call) => api.markOut(body, call),
    undoMarkOut: (scanId, idempotencyKey) => api.undo(scanId, { idempotencyKey }),
  };
}
