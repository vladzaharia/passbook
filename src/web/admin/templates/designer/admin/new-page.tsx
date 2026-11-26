import { Navigate, useNavigate } from '@tanstack/react-router';
import { useCallback, useMemo } from 'react';
import { PHONE, useMediaQuery } from '../../../../lib/media.ts';
import { markMinted } from '../../../../lib/motion.ts';
import { useOrgScope } from '../../../../lib/org-filter.tsx';
import { useSession } from '../../../../lib/session.ts';
import { Button, Callout, detailError, PageHeader } from '../../../../ui/index.ts';
import { useUseBlueprint } from '../../../blueprints/api.ts';
import { markCreated } from '../../../passes/created.tsx';
import { useTemplate } from '../../api.ts';
import { docOf, useBaseVersion } from '../api.ts';
import type { CreateDesign } from '../create-flow.ts';
import { Designer } from '../designer.tsx';
import { DesignerSkeleton } from '../designer-skeleton.tsx';
import { draftKey } from '../drafts.ts';
import { assetsPayload } from '../images.ts';
import type { DesignDoc } from '../model.ts';
import { AdminDesignerHost } from './host.tsx';

/** The blueprint's own design, named for the new template and without the blueprint flag. */
function draftOf(base: DesignDoc, name: string): DesignDoc {
  const { blueprint: _flag, org: _org, ...manifest } = base.manifest;
  return { ...base, manifest: { ...manifest, name } };
}

/**
 * Use blueprint, step two: the designer on a draft of the blueprint for the selected organization.
 * Nothing exists until Create template saves it as the template's first version.
 */
export function NewTemplatePage({
  blueprintId,
  name,
}: {
  blueprintId: string | undefined;
  name: string | undefined;
}) {
  if (!blueprintId || !name?.trim())
    return <Navigate from="/admin/o/$orgId" to="/admin/o/$orgId/blueprints" replace />;
  return (
    <AdminDesignerHost>
      <NewFromBlueprint blueprintId={blueprintId} name={name.trim()} />
    </AdminDesignerHost>
  );
}

function NewFromBlueprint({ blueprintId, name }: { blueprintId: string; name: string }) {
  const navigate = useNavigate();
  const { authed } = useSession();
  const phone = useMediaQuery(PHONE);
  const { orgId, membership } = useOrgScope();
  const blueprint = useTemplate(orgId ? blueprintId : undefined, orgId);
  const version = useBaseVersion(blueprintId, blueprint.data?.activeVersion ?? null);
  const create = useUseBlueprint(blueprintId);
  const base = useMemo(
    () => (version.data ? draftOf(docOf(version.data), name) : null),
    [version.data, name],
  );
  const onCreated = useCallback(
    (templateId: string) =>
      orgId &&
      void navigate({
        to: '/admin/o/$orgId/templates/$templateId',
        params: { orgId, templateId },
      }),
    [navigate, orgId],
  );
  const header = (
    <PageHeader
      title={`Design ${name}`}
      breadcrumbs={[{ label: 'Blueprints', to: '/admin/blueprints' }, { label: 'New template' }]}
    />
  );
  const failed = blueprint.isError ? blueprint : version.isError ? version : null;
  if (failed) return detailError(failed, { entity: 'blueprint', to: '/admin/blueprints', header });
  if (blueprint.data && !blueprint.data.blueprint)
    return (
      <Navigate
        from="/admin/o/$orgId"
        to="/admin/o/$orgId/templates/$templateId"
        params={{ templateId: blueprintId }}
        replace
      />
    );
  if (!blueprint.data || !base || !version.data || !orgId || !membership) {
    return (
      <>
        {header}
        <DesignerSkeleton />
      </>
    );
  }
  const designing: CreateDesign = {
    blueprintName: blueprint.data.name,
    name,
    orgId,
    orgName: membership.orgName,
    async onCreate(doc) {
      const made = await create.mutateAsync({
        orgId,
        name,
        version: {
          passJson: doc.passJson,
          manifest: doc.manifest as never,
          assets: assetsPayload(doc.assets),
        },
      });
      markMinted(`template:${made.id}`);
      markCreated(`template:${made.id}`, 'fromBlueprint');
      return made.id;
    },
    onCreated,
  };
  if (phone) {
    // The designer is out of reach here: make the template as it is.
    return (
      <>
        {header}
        <Callout
          tone="info"
          actions={
            <Button
              size="sm"
              loading={create.isPending}
              onClick={() => void designing.onCreate(base).then(onCreated)}
            >
              Create template
            </Button>
          }
        >
          The designer needs a tablet or desktop screen.
        </Callout>
      </>
    );
  }
  return (
    <Designer
      key={`${blueprintId}:${orgId}`}
      template={{ ...blueprint.data, name, orgId, orgName: membership.orgName, blueprint: false }}
      draftKey={draftKey(authed?.user.id ?? 'anonymous', orgId, `new:${blueprintId}`)}
      base={{ version: version.data.version, doc: base }}
      draft={null}
      assetBase={(v) =>
        `/api/v1/templates/${encodeURIComponent(blueprintId)}/versions/${encodeURIComponent(v)}/assets?orgId=${encodeURIComponent(orgId)}`
      }
      create={designing}
    />
  );
}
