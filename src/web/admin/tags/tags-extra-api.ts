import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { z } from 'zod';
import { TagHistorySchema, UserTagListSchema } from '@/shared/contracts/nfc-tag-admin.ts';
import { type CreateTagEnrollmentSchema, TagSchema } from '@/shared/contracts/nfc-tags.ts';
import { api } from '@/web/lib/api.ts';
import { useMode } from '@/web/lib/mode.ts';
import { tagKeys } from './api.ts';

/** The T5 admin routes for changing, rebinding, history and a user's tags. */
const NFC = '/api/v1/nfc';
export type BindingKind = z.input<typeof CreateTagEnrollmentSchema>['binding'];

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
      api.get(`${NFC}/tags/${encodeURIComponent(tagId)}/history`, TagHistorySchema, {
        signal,
      }),
  });
}

export function useUserTagList(userId: string) {
  const mode = useMode();
  return useQuery({
    queryKey: ['tags', 'user', userId, mode],
    queryFn: ({ signal }) =>
      api.get(`${NFC}/users/${encodeURIComponent(userId)}/tags`, UserTagListSchema, {
        signal,
      }),
  });
}
