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
import { Button } from '../../../ui/button.tsx';
import { ErrorState } from '../../../ui/error-state.tsx';
import { Skeleton } from '../../../ui/skeleton.tsx';
import { toast } from '../../../ui/toaster.tsx';
import { useToolHost } from '../../host/tool-host.tsx';
import type { InputValues } from '../../playground/model.ts';
import { ToolPage } from '../../shell/tool-page.tsx';
import { wantIssueFocus } from '../issue-focus.ts';
import { handoffCode, handoffState, ownsHandoff, spendHandoff } from './handoff.ts';
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
  // Unasked only for the hand-off this tab started; any other link shows the values and waits for Save.
  const own = useRef(ownsHandoff(location.hash));
  const [confirmed, setConfirmed] = useState(own.current);
  // One key per hand-off, so a retry or a reload never makes a second template.
  const key = useRef(own.current ? `anon-${handoffCode(location.hash)}` : crypto.randomUUID());
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
      // A second save of the same blueprint finds its name taken: the next free number goes on it.
      let made: Awaited<ReturnType<typeof api.post<typeof TemplateDetailSchema>>> | undefined;
      for (let n = 1; !made; n++) {
        try {
          made = await api.post(
            `${path}/use`,
            TemplateDetailSchema,
            { ...body, name: n === 1 ? blueprint.name : `${blueprint.name} ${n}` },
            { headers: { 'idempotency-key': `${key.current}-${n}` } },
          );
        } catch (cause) {
          if (!(cause instanceof ApiError) || cause.code !== 'TEMPLATE_EXISTS' || n >= 9)
            throw cause;
        }
      }
      const first = made.activeVersion ?? made.versions[0]?.version;
      if (first)
        await releaseInTest(api, orgId, made.id, first, crypto.randomUUID()).catch((cause) =>
          toast.error(cause, WB_DESIGN.phone.noRelease),
        );
      clearMirror();
      if (own.current) spendHandoff();
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
    if (confirmed) void run();
  }, [confirmed, run]);

  if (!confirmed) {
    const edits = Object.entries(handoffState(location.hash).edits);
    return (
      <ToolPage tool="design">
        <div className="grid max-w-md gap-3">
          <p className="text-sm text-fg-strong">{WB_DESIGN.anon.review}</p>
          {edits.length > 0 ? (
            <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-sm">
              {edits.map(([name, value]) => (
                <div key={name} className="contents">
                  <dt className="text-fg-muted">{name}</dt>
                  <dd className="min-w-0 break-words font-mono text-xs text-fg">
                    {typeof value === 'string' ? value : JSON.stringify(value)}
                  </dd>
                </div>
              ))}
            </dl>
          ) : (
            <p className="text-sm text-fg-muted">{WB_DESIGN.anon.noEdits}</p>
          )}
          <div className="flex gap-2">
            <Button onClick={() => setConfirmed(true)}>{WB_DESIGN.anon.save}</Button>
            <Button
              variant="outline"
              onClick={() => router.history.replace(wbPath(orgId, 'design'))}
            >
              {WB_DESIGN.anon.cancel}
            </Button>
          </div>
        </div>
      </ToolPage>
    );
  }
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
