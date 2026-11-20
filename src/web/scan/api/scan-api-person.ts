import type { z } from 'zod';
import {
  type HistoryFilter,
  HistoryPageSchema,
  type PassNoteRequestSchema,
  PassNoteSchema,
  PassNotesSchema,
} from '../../../shared/contracts/scan-history.ts';
import type { Call } from './scan-api-support.ts';

/** The device's one request function: the credential, the retries and the typed answer. */
export type ScanRequest = <S extends z.ZodType>(
  method: 'GET' | 'POST' | 'DELETE',
  path: string,
  schema: S | null,
  body?: unknown,
  call?: Call,
) => Promise<z.infer<S>>;

/** A person's history and staff notes. */
export function personCalls(request: ScanRequest) {
  return {
    history: (
      passId: string,
      query: { filter: HistoryFilter; cursor?: string | null },
      call?: Call,
    ) => {
      const qs = new URLSearchParams({ filter: query.filter, limit: '20' });
      if (query.cursor) qs.set('cursor', query.cursor);
      return request(
        'GET',
        `/passes/${encodeURIComponent(passId)}/history?${qs}`,
        HistoryPageSchema,
        undefined,
        call,
      );
    },
    notes: (passId: string, call?: Call) =>
      request(
        'GET',
        `/passes/${encodeURIComponent(passId)}/notes`,
        PassNotesSchema,
        undefined,
        call,
      ),
    addNote: (passId: string, body: z.infer<typeof PassNoteRequestSchema>, call?: Call) =>
      request('POST', `/passes/${encodeURIComponent(passId)}/notes`, PassNoteSchema, body, call),
  };
}
