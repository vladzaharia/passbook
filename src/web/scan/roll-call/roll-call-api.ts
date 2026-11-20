import type { ScanApi } from '../api/scan-api.ts';
import type { RollCallPort } from './use-roll-call.ts';

/** The real calls behind the roll call. */
export const rollCallPort = (api: ScanApi): RollCallPort => ({
  current: (call) => api.rollCall(call),
  start: () => api.startRollCall(),
  marks: (id, marks) => api.rollCallMarks(id, { marks }),
  end: (id) => api.endRollCall(id),
});
