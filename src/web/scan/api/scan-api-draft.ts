import {
  type ScanDraftRequest,
  ScanDraftResultSchema,
} from '../../../shared/contracts/scan-draft.ts';
import type { Call, ScanRequest } from './scan-api-support.ts';

/** The amount under review, shown on the customer screens that follow this scanner. */
export function draftCalls(request: ScanRequest) {
  return {
    draftPut: (body: ScanDraftRequest, call?: Call) =>
      request('PUT', '/draft', ScanDraftResultSchema, body, call),
    draftClear: (ref: string, keep: boolean, call?: Call) =>
      request(
        'DELETE',
        `/draft?ref=${encodeURIComponent(ref)}${keep ? '&keep=ready' : ''}`,
        ScanDraftResultSchema,
        undefined,
        call,
      ),
  };
}
