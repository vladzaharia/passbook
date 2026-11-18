import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { z } from 'zod';
import { IdSchema, pageOf } from '@/shared/contracts/common.ts';
import {
  type CreateTagEnrollmentSchema,
  TagBindingSchema,
  TagSchema,
} from '@/shared/contracts/nfc-tags.ts';
import { api } from '@/web/lib/api.ts';
import { useMode } from '@/web/lib/mode.ts';
import { tagKeys } from './api.ts';

/**
 * Routes T5 builds for the tag UI (not on the server yet), typed here so the screens run against
 * fakes in tests. Exact shapes are listed in agent-logs/t9-results.md:
 *   PATCH /api/v1/nfc/bindings/{bindingId}   { binding: 'pass' | 'user', passId? }          -> Tag
 *   POST  /api/v1/nfc/passes/{passId}/tags   { tagId, binding }                      -> Tag
 *   GET   /api/v1/nfc/tags/{tagId}/history                                           -> page of TagBinding (ended too, newest first)
 *   GET   /api/v1/nfc/users/{userId}/tags                                            -> page of Tag + { orgId, orgName }
 */
const NFC = '/api/v1/nfc';
export type BindingKind = z.input<typeof CreateTagEnrollmentSchema>['binding'];

export const UserTagSchema = TagSchema.extend({ orgId: IdSchema, orgName: z.string() });

export function useExtraTagMutations() {
  const client = useQueryClient();
  const refresh = () => client.invalidateQueries({ queryKey: tagKeys.all });
  return {
    changeBinding: useMutation({
      mutationFn: ({
        bindingId,
        binding,
        passId,
      }: {
        bindingId: string;
        binding: BindingKind;
        /** Narrowing a person-wide tag: the pass it should keep. */
        passId?: string | undefined;
      }) =>
        api.patch(`${NFC}/bindings/${encodeURIComponent(bindingId)}`, TagSchema, {
          binding,
          passId,
        }),
      onSuccess: refresh,
    }),
    rebind: useMutation({
      mutationFn: ({
        passId,
        tagId,
        binding,
      }: {
        passId: string;
        tagId: string;
        binding: BindingKind;
      }) =>
        api.post(`${NFC}/passes/${encodeURIComponent(passId)}/tags`, TagSchema, {
          tagId,
          binding,
        }),
      onSuccess: refresh,
    }),
  };
}

export function useTagHistory(tagId: string) {
  return useQuery({
    queryKey: ['tags', 'history', tagId],
    queryFn: ({ signal }) =>
      api.get(`${NFC}/tags/${encodeURIComponent(tagId)}/history`, pageOf(TagBindingSchema), {
        signal,
      }),
  });
}

export function useUserTagList(userId: string) {
  const mode = useMode();
  return useQuery({
    queryKey: ['tags', 'user', userId, mode],
    queryFn: ({ signal }) =>
      api.get(`${NFC}/users/${encodeURIComponent(userId)}/tags`, pageOf(UserTagSchema), {
        signal,
      }),
  });
}
