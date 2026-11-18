import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { z } from 'zod';
import { pageOf, TimestampSchema } from '@/shared/contracts/common.ts';
import {
  type CreateTagEnrollmentSchema,
  TagEnrollmentSchema,
  TagScannerSchema,
} from '@/shared/contracts/nfc-tags.ts';
import { api } from '@/web/lib/api.ts';
import { useMode } from '@/web/lib/mode.ts';
import { tagKeys } from './api.ts';

/**
 * Remote enrollment, "Assign with a scanner" (T5). T5 is not built; these are the routes the
 * design names (access-nfc-design 8.2), typed by the contract so a change there fails here:
 *   GET    /api/v1/nfc/scanners?orgId              NFC-capable scanners in this org and mode
 *   POST   /api/v1/nfc/passes/{passId}/enrollments { scannerId, scope }
 *   GET    /api/v1/nfc/passes/{passId}/enrollments/{id}
 *   DELETE /api/v1/nfc/passes/{passId}/enrollments/{id}
 */
const NFC = '/api/v1/nfc';
const enrollments = (passId: string) => `${NFC}/passes/${encodeURIComponent(passId)}/enrollments`;

/** The admin polls every 1.5 s while a request is pending. */
export const ENROLL_POLL_MS = 1500;
/** A request lasts two minutes. */
export const ENROLL_TTL_MS = 120_000;

/**
 * The contract has no "the scanner showed it" signal, yet the dialog's second step needs one.
 * Assumed: T5 adds `shownAt` to the enrollment. Until then it reads null and the step stays open.
 */
export const EnrollmentSchema = TagEnrollmentSchema.extend({
  shownAt: TimestampSchema.nullable().default(null),
});
export type Enrollment = z.infer<typeof EnrollmentSchema>;
export type EnrollmentBody = z.input<typeof CreateTagEnrollmentSchema>;

export function useTagScanners(orgId: string, enabled: boolean) {
  const mode = useMode();
  return useQuery({
    queryKey: ['tag-scanners', orgId, mode],
    enabled,
    queryFn: ({ signal }) =>
      api.get(`${NFC}/scanners`, pageOf(TagScannerSchema), { query: { orgId }, signal }),
  });
}

export function useCreateEnrollment(passId: string) {
  return useMutation({
    mutationFn: (body: EnrollmentBody) => api.post(enrollments(passId), EnrollmentSchema, body),
  });
}

/** Polls one request until it ends; the poll stops with the component. */
export function useEnrollment(passId: string, id: string | undefined, pollMs = ENROLL_POLL_MS) {
  const client = useQueryClient();
  return useQuery({
    queryKey: ['tag-enrollment', id ?? ''],
    enabled: Boolean(id),
    queryFn: async ({ signal }) => {
      const next = await api.get(
        `${enrollments(passId)}/${encodeURIComponent(id ?? '')}`,
        EnrollmentSchema,
        {
          signal,
        },
      );
      if (next.state === 'done') void client.invalidateQueries({ queryKey: tagKeys.all });
      return next;
    },
    refetchInterval: (query) =>
      query.state.data?.state === 'pending' || !query.state.data ? pollMs : false,
    staleTime: 0,
    gcTime: 0,
  });
}

export function useCancelEnrollment(passId: string) {
  return useMutation({
    mutationFn: (id: string) =>
      api.deleteJson(`${enrollments(passId)}/${encodeURIComponent(id)}`, EnrollmentSchema),
  });
}
