import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useRouter } from '@tanstack/react-router';
import type { z } from 'zod';
import { TemplateDetailSchema, type TemplateSummaryDto } from '@/shared/contracts/templates.ts';
import { WB_DESIGN } from '@/shared/copy/workbench-design.ts';
import { wbPath } from '@/shared/workbench.ts';
import { releaseInTest } from '../../admin/templates/designer/hosts.tsx';
import { templateKeys } from '../../admin/templates/keys.ts';
import { ApiError } from '../../lib/errors.ts';
import { toast } from '../../ui/toaster.tsx';
import { useToolHost } from '../host/tool-host.tsx';
import { wantIssueFocus } from './issue-focus.ts';

const enc = encodeURIComponent;

/** A second copy of the same blueprint finds its name taken: the next free number goes on it. */
export async function postUnique(
  name: string,
  key: string,
  send: (name: string, key: string) => Promise<z.infer<typeof TemplateDetailSchema>>,
): Promise<z.infer<typeof TemplateDetailSchema>> {
  for (let n = 1; ; n++) {
    try {
      return await send(n === 1 ? name : `${name} ${n}`, `${key}-${n}`);
    } catch (cause) {
      if (!(cause instanceof ApiError) || cause.code !== 'TEMPLATE_EXISTS' || n >= 9) throw cause;
    }
  }
}

/**
 * Start from a blueprint: an exact copy in this context (`POST /templates/{id}/use`), released to
 * Test so a test pass can be issued, then Design opens on it.
 */
export function useStartFromBlueprint() {
  const { api, context } = useToolHost();
  const router = useRouter();
  const qc = useQueryClient();
  const { orgId } = context;
  return useMutation({
    mutationFn: async (blueprint: TemplateSummaryDto) => {
      const key = crypto.randomUUID();
      const made = await postUnique(blueprint.name, key, (name, k) =>
        api.post(
          `/api/v1/templates/${enc(blueprint.id)}/use`,
          TemplateDetailSchema,
          { orgId, name },
          { headers: { 'idempotency-key': k } },
        ),
      );
      const first = made.activeVersion ?? made.versions[0]?.version;
      if (first)
        await releaseInTest(api, orgId, made.id, first, crypto.randomUUID()).catch((cause) =>
          toast.error(cause, WB_DESIGN.phone.noRelease),
        );
      return made;
    },
    onSuccess: async (made) => {
      await qc.invalidateQueries({ queryKey: templateKeys.all });
      wantIssueFocus();
      router.history.push(`${wbPath(orgId, 'design')}/${enc(made.id)}`);
    },
    onError: (cause) => toast.error(cause, WB_DESIGN.index.startFailed),
  });
}
