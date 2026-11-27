import { useRouter } from '@tanstack/react-router';
import { useCallback, useEffect, useRef, useState } from 'react';
import type { UseBlueprintRequest } from '@/shared/contracts/template-versions.ts';
import { TemplateDetailSchema, TemplateVersionDetailSchema } from '@/shared/contracts/templates.ts';
import { WB_DESIGN } from '@/shared/copy/workbench-design.ts';
import { wbPath } from '@/shared/workbench.ts';
import { docOf } from '../../../admin/templates/designer/api.ts';
import { releaseInTest } from '../../../admin/templates/designer/hosts.tsx';
import { isRecord } from '../../../admin/templates/designer/model.ts';
import { ApiError } from '../../../lib/errors.ts';
import { ErrorState } from '../../../ui/error-state.tsx';
import { Skeleton } from '../../../ui/skeleton.tsx';
import { toast } from '../../../ui/toaster.tsx';
import { useToolHost } from '../../host/tool-host.tsx';
import type { InputValues } from '../../playground/model.ts';
import { ToolPage } from '../../shell/tool-page.tsx';
import { wantIssueFocus } from '../issue-focus.ts';
import { handoffState } from './handoff.ts';
import { clearMirror } from './use-anon-state.ts';

const enc = encodeURIComponent;

/** The blueprint's sample with the visitor's edits over it; an edit of `null` takes the field out. */
export function sampleWith(sample: InputValues, edits: InputValues): InputValues {
  const out: InputValues = { ...sample, ...edits };
  for (const [key, value] of Object.entries(out)) if (value === null) delete out[key];
  return out;
}

/**
 * The hand-off's last step, in the person's sandbox on the Workbench token: the blueprint becomes
 * the sandbox's template with the sample they edited (`POST /templates/{id}/use`), is released to
 * Test so a test pass can be issued, and Design opens on it (design §1.9).
 */
export function HandoffSave() {
  const host = useToolHost();
  const router = useRouter();
  const [failure, setFailure] = useState<unknown>(null);
  const running = useRef(false);
  const { api } = host;
  const { orgId } = host.context;

  const run = useCallback(async () => {
    if (running.current) return;
    running.current = true;
    setFailure(null);
    try {
      const state = handoffState(location.hash);
      const path = `/api/v1/templates/${enc(state.template)}`;
      const blueprint = await api.get(path, TemplateDetailSchema, { query: { orgId } });
      if (!blueprint.blueprint || !blueprint.activeVersion)
        throw new ApiError({ status: 404, code: 'not_found', detail: WB_DESIGN.anon.noBlueprint });
      const version = await api.get(
        `${path}/versions/${enc(blueprint.activeVersion)}`,
        TemplateVersionDetailSchema,
        { query: { orgId } },
      );
      const doc = docOf(version);
      const sample = sampleWith(
        isRecord(doc.manifest.sample) ? doc.manifest.sample : {},
        state.edits,
      );
      const body: UseBlueprintRequest = {
        orgId,
        name: blueprint.name,
        baseVersion: version.version,
        version: {
          passJson: doc.passJson,
          manifest: { ...doc.manifest, sample } as never,
          assets: doc.assets.flatMap((a) => (a.sha1 ? [{ name: a.name, sha1: a.sha1 }] : [])),
        },
      };
      const made = await api.post(`${path}/use`, TemplateDetailSchema, body, {
        headers: { 'idempotency-key': crypto.randomUUID() },
      });
      const first = made.activeVersion ?? made.versions[0]?.version;
      if (first)
        await releaseInTest(api, orgId, made.id, first, crypto.randomUUID()).catch((cause) =>
          toast.error(cause, WB_DESIGN.phone.noRelease),
        );
      clearMirror();
      wantIssueFocus();
      router.history.replace(`${wbPath(orgId, 'design')}/${enc(made.id)}`);
      toast.success(WB_DESIGN.anon.saved(made.name));
    } catch (cause) {
      setFailure(cause);
    } finally {
      running.current = false;
    }
  }, [api, orgId, router]);

  useEffect(() => {
    void run();
  }, [run]);

  return (
    <ToolPage tool="design">
      {failure ? (
        <ErrorState error={failure} title={WB_DESIGN.anon.saveFailed} onRetry={() => void run()} />
      ) : (
        <div role="status" aria-busy className="grid max-w-md gap-2">
          <p className="text-sm text-fg-muted">{WB_DESIGN.anon.saving}</p>
          <Skeleton className="h-11 w-full" />
        </div>
      )}
    </ToolPage>
  );
}
