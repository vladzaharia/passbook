import { useMutation, useQueryClient } from '@tanstack/react-query';
import { MODE_HEADER } from '@/shared/contracts/common.ts';
import {
  TemplateApprovalSchema,
  type TemplateCandidate,
  type TemplateCandidateCurrent,
  TemplateCandidateSchema,
  TemplateReleaseSchema,
  type TemplateReleaseScope,
} from '@/shared/contracts/template-releases.ts';
import { api } from '../../../lib/api.ts';

export interface WalletApproval {
  current: TemplateCandidateCurrent;
  /** Every omission the report has: the server requires the candidate to name all of them. */
  keys: readonly string[];
  /** A candidate already requested for these omissions; none creates one. */
  existing?: TemplateCandidate | undefined;
  /** Approve it; false stops after creating the candidate (request review). */
  approve: boolean;
  /** The author's own approval, sent only when the release state says they are alone. */
  alone: boolean;
  /** Publish after approving, at this head generation. */
  publishAt?: number | undefined;
}

/**
 * Request, approve and release a wallet candidate in the three calls the API has. A candidate
 * left by a failed approval is found again in the refreshed list and approved on retry.
 */
export function useWalletApproval(templateId: string, scope: TemplateReleaseScope) {
  const client = useQueryClient();
  const base = `/api/v1/templates/${encodeURIComponent(templateId)}`;
  const opts = { headers: { [MODE_HEADER]: scope.mode } };
  return useMutation({
    mutationFn: async (input: WalletApproval) => {
      const candidate =
        input.existing ??
        (await api.post(
          `${base}/candidates`,
          TemplateCandidateSchema,
          {
            ...scope,
            version: input.current.version,
            sourceReleaseId: input.current.sourceReleaseId,
            projection: {
              schema: 2,
              provider: scope.provider,
              approvedOmissions: [...input.keys],
            },
          },
          opts,
        ));
      if (!input.approve) return { candidate, released: false };
      const approval = await api.post(
        `${base}/candidates/${encodeURIComponent(candidate.id)}/approve`,
        TemplateApprovalSchema,
        {
          ...scope,
          candidateHash: candidate.candidateHash,
          ...(input.alone ? { alone: true } : {}),
        },
        opts,
      );
      if (input.publishAt === undefined) return { candidate, released: false };
      await api.post(
        `${base}/releases`,
        TemplateReleaseSchema,
        {
          ...scope,
          candidateId: candidate.id,
          approvalId: approval.id,
          candidateHash: candidate.candidateHash,
          expectedGeneration: input.publishAt,
        },
        opts,
      );
      return { candidate, released: true };
    },
    onSettled: () =>
      Promise.all([
        client.invalidateQueries({ queryKey: ['admin', 'template-releases', templateId] }),
        client.invalidateQueries({ queryKey: ['admin', 'templates'] }),
      ]),
  });
}
