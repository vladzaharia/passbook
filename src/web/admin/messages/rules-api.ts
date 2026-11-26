import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  type MessageRuleBody,
  MessageRuleListSchema,
  MessageRuleSchema,
  RulePreviewSchema,
  type UpdateMessageRuleBody,
} from '@/shared/contracts/message-rules.ts';
import { api } from '../../lib/api.ts';
import { isApiError } from '../../lib/errors.ts';

const BASE = '/api/v1/message-rules';
const path = (id: string) => `${BASE}/${encodeURIComponent(id)}`;
export const ruleKeys = { all: (orgId: string) => ['admin', 'message-rules', orgId] as const };

/** A save over a rule someone else saved first (409 `RULE_VERSION`). */
export const isRuleStale = (cause: unknown): boolean =>
  isApiError(cause) && cause.status === 409 && cause.code === 'RULE_VERSION';

export function useRules(orgId: string) {
  return useQuery({
    queryKey: ruleKeys.all(orgId),
    queryFn: ({ signal }) => api.get(BASE, MessageRuleListSchema, { query: { orgId }, signal }),
  });
}

/** Passes due in the next 14 days for an unsaved rule; only asked once the body is valid. */
export function useRulePreview(body: MessageRuleBody | undefined, ruleId?: string) {
  return useQuery({
    queryKey: ['admin', 'message-rules', 'preview', body, ruleId] as const,
    queryFn: ({ signal }) =>
      api.post(`${BASE}/preview`, RulePreviewSchema, { ...body, ruleId }, { signal }),
    enabled: body !== undefined,
    placeholderData: (previous) => previous,
  });
}

export function useRuleActions(orgId: string) {
  const qc = useQueryClient();
  const done = () => qc.invalidateQueries({ queryKey: ruleKeys.all(orgId) });
  return {
    create: useMutation({
      mutationFn: (body: MessageRuleBody) => api.post(BASE, MessageRuleSchema, body),
      onSuccess: done,
    }),
    update: useMutation({
      mutationFn: ({ id, body }: { id: string; body: UpdateMessageRuleBody }) =>
        api.put(path(id), MessageRuleSchema, body),
      onSuccess: done,
    }),
    pause: useMutation({
      mutationFn: (id: string) => api.post(`${path(id)}/pause`, MessageRuleSchema),
      onSuccess: done,
    }),
    remove: useMutation({
      mutationFn: (id: string) => api.delete(path(id)),
      onSuccess: done,
    }),
  };
}
