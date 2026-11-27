import { useMemo } from 'react';
import { WB_DESIGN } from '@/shared/copy/workbench-design.ts';
import { Designer } from '../../../admin/templates/designer/designer.tsx';
import {
  DesignerHostProvider,
  fetchBytes,
  sharedLoader,
} from '../../../admin/templates/designer/host.tsx';
import { anonymousDesignerHost } from '../../../admin/templates/designer/hosts.tsx';
import { ApiError } from '../../../lib/errors.ts';
import { Callout } from '../../../ui/callout.tsx';
import { TemplateProvider } from '../template-context.tsx';
import { useAnon } from './anon-context.tsx';
import { ANON_EXTRAS } from './anon-extras.tsx';
import type { AnonBlueprint } from './blueprint.ts';
import { useLivePass } from './use-live-pass.ts';

/**
 * A blueprint in the designer core with no session: the anonymous host reads it, loads its files
 * from the blueprint's own static folder with no credentials, and cannot edit, save or issue. The
 * blueprint is the template.
 */
export function AnonDesign({ blueprint }: { blueprint: AnonBlueprint }) {
  const { template, doc, preview } = blueprint;
  const folder = preview.assetBaseUrl;
  const host = useMemo(() => {
    const load = sharedLoader((path) => fetchBytes(path, { credentials: 'omit' }));
    return {
      ...anonymousDesignerHost({}),
      // Nothing but the blueprint's own files: no API path is ever asked for.
      loadAsset: (path: string, signal?: AbortSignal) =>
        new URL(path, location.origin).pathname.startsWith(`${folder}/`)
          ? load(path, signal)
          : Promise.reject(
              new ApiError({ status: 404, code: 'asset_unavailable', detail: 'No file.' }),
            ),
      extras: ANON_EXTRAS,
    };
  }, [folder]);
  const { values } = useAnon();
  const { pass, failed } = useLivePass(blueprint, values);
  const readOnly = useMemo(
    () => ({
      notice: failed ? (
        <Callout className="mb-4" tone="warning">
          {WB_DESIGN.anon.liveFailed}
        </Callout>
      ) : null,
      passJson: pass,
      issues: [],
    }),
    [pass, failed],
  );
  const open = useMemo(() => ({ id: template.id, name: template.name }), [template]);
  return (
    <DesignerHostProvider host={host}>
      <TemplateProvider value={open}>
        <Designer
          key={template.id}
          template={template}
          draftKey={`anonymous:${template.id}`}
          base={{ version: '1', doc }}
          draft={null}
          readOnly={readOnly}
          density="compact"
          assetBase={() => folder}
        />
      </TemplateProvider>
    </DesignerHostProvider>
  );
}
