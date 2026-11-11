import { useEffect, useMemo, useState } from 'react';
import type { z } from 'zod';
import type {
  TemplateDetailSchema,
  TemplateVersionDetailSchema,
} from '@/shared/contracts/templates.ts';
import { isApiError } from '../../../lib/errors.ts';
import { useOrgScope, useResourceOrg } from '../../../lib/org-filter.tsx';
import { useSession } from '../../../lib/session.ts';
import {
  Button,
  Callout,
  type Crumb,
  DetailNotFound,
  detailError,
  EmptyState,
  PageHeader,
} from '../../../ui/index.ts';
import { useTemplate, useTemplatePreview } from '../api.ts';
import { useBaseVersion } from './api.ts';
import { Designer, type ReadOnlyDesign } from './designer.tsx';
import { DesignerSkeleton } from './designer-skeleton.tsx';
import { clearDraft, draftKey, loadDraft } from './drafts.ts';
import type { DesignDoc } from './model.ts';
import { ReadOnlyNotice } from './read-only-notice.tsx';

type Template = z.infer<typeof TemplateDetailSchema>;
type Version = z.infer<typeof TemplateVersionDetailSchema>;
type Crumbs = Crumb[];

export function docOf(v: Version): DesignDoc {
  return {
    passJson: structuredClone(v.passJson),
    manifest: structuredClone(v.manifest) as Record<string, unknown>,
    assets: v.assets.map((a) => ({
      name: a.name,
      slot: a.slot,
      scale: a.scale,
      size: a.size,
      width: a.width,
      height: a.height,
      sha1: a.sha1,
    })),
  };
}

export function TemplateDesignerPage({ templateId }: { templateId: string }) {
  const { hasExplicitOrg } = useOrgScope();
  return (
    <TemplateDesignerResource
      key={JSON.stringify([templateId, hasExplicitOrg])}
      templateId={templateId}
    />
  );
}

function TemplateDesignerResource({ templateId }: { templateId: string }) {
  const scope = useOrgScope();
  const canFetch =
    !scope.isLoading &&
    !scope.isError &&
    (scope.hasExplicitOrg
      ? Boolean(
          scope.membership?.capabilities.includes('templates:author') &&
            scope.membership?.capabilities.includes('templates:read'),
        )
      : scope.memberships.some(
          (m) =>
            m.capabilities.includes('templates:author') &&
            m.capabilities.includes('templates:read'),
        ));
  const template = useTemplate(
    canFetch ? templateId : undefined,
    scope.hasExplicitOrg ? scope.orgId : undefined,
  );
  const fresh = scope.hasExplicitOrg || (template.isFetchedAfterMount && !template.isError);
  const resourceScope = useResourceOrg(fresh ? template.data?.orgId : undefined, true);
  useEffect(() => {
    if (
      canFetch &&
      !scope.hasExplicitOrg &&
      !template.isFetchedAfterMount &&
      !template.isFetching
    ) {
      void template.refetch();
    }
  }, [
    canFetch,
    scope.hasExplicitOrg,
    template.isFetchedAfterMount,
    template.isFetching,
    template.refetch,
  ]);
  const crumbs = [
    { label: 'Templates', to: '/admin/templates', search: { orgId: scope.orgId } },
    { label: 'Template' },
    { label: 'Design' },
  ];
  if (!scope.isLoading && !canFetch) {
    return (
      <>
        <PageHeader title="Design" breadcrumbs={crumbs} />
        <DetailNotFound entity="template" to="/admin/templates" />
      </>
    );
  }
  if (
    resourceScope === 'choose-org' ||
    (!scope.hasExplicitOrg &&
      template.isFetchedAfterMount &&
      isApiError(template.error) &&
      template.error.isForbidden)
  ) {
    return (
      <EmptyState
        heading
        art="building"
        title="Choose an organization"
        description="Choose an organization in the top bar to continue."
      />
    );
  }
  if (template.isError && (scope.hasExplicitOrg || template.isFetchedAfterMount)) {
    return detailError(template, {
      entity: 'template',
      to: '/admin/templates',
      header: <PageHeader title="Design" breadcrumbs={crumbs} />,
    });
  }
  if (resourceScope === 'pending' || !template.data) {
    return (
      <>
        <PageHeader title="Design" breadcrumbs={crumbs} />
        <DesignerSkeleton />
      </>
    );
  }
  if (
    resourceScope === 'not-found' ||
    !scope.orgId ||
    (template.data.orgId !== null && template.data.orgId !== scope.orgId)
  ) {
    return (
      <>
        <PageHeader title="Design" breadcrumbs={crumbs} />
        <DetailNotFound entity="template" to="/admin/templates" />
      </>
    );
  }
  return (
    <Loaded
      key={`${scope.orgId}:${template.data.id}`}
      template={template.data}
      crumbs={[
        { label: 'Templates', to: '/admin/templates', search: { orgId: scope.orgId } },
        {
          label: template.data.name,
          to: `/admin/templates/${templateId}`,
          search: { orgId: scope.orgId },
        },
        { label: 'Design' },
      ]}
    />
  );
}

function Loaded({ template: t, crumbs }: { template: Template; crumbs: Crumbs }) {
  // Keep the version opened here stable while another administrator changes the active one.
  // A newly imported inactive template starts from its newest candidate.
  const [opened] = useState(() => {
    if (t.activeVersion) return t.activeVersion;
    let latest: Template['versions'][number] | undefined;
    for (const candidate of t.versions) {
      if (!latest || candidate.createdAt > latest.createdAt) latest = candidate;
    }
    return latest?.version ?? null;
  });
  const { isAdmin } = useSession();
  const scope = useOrgScope();
  const version = useBaseVersion(t.id, opened);
  const sharedReadOnly = t.orgId === null && !isAdmin;
  const locked = t.origin === 'baked' || t.status !== 'active' || sharedReadOnly;
  const preview = useTemplatePreview(locked ? t.id : '', scope.orgId);
  const base = useMemo(() => (version.data ? docOf(version.data) : null), [version.data]);
  if (!opened) {
    return (
      <>
        <PageHeader title={t.name} breadcrumbs={crumbs} />
        <EmptyState art="template" title="No versions yet" />
      </>
    );
  }
  if (version.isError) {
    return detailError(version, {
      entity: 'template',
      to: `/admin/templates/${t.id}`,
      header: <PageHeader title={t.name} breadcrumbs={crumbs} />,
    });
  }
  if (!base || !version.data) {
    return (
      <>
        <PageHeader title={t.name} breadcrumbs={crumbs} />
        <DesignerSkeleton />
      </>
    );
  }
  const readOnly: ReadOnlyDesign | undefined = locked
    ? {
        notice: <ReadOnlyNotice template={t} sharedReadOnly={sharedReadOnly} />,
        passJson: preview.data?.passJson ?? null,
        issues: version.data.report.issues,
      }
    : undefined;
  return <Ready template={t} version={version.data} base={base} readOnly={readOnly} />;
}

function Ready({
  template: t,
  version,
  base,
  readOnly,
}: {
  template: Template;
  version: Version;
  base: DesignDoc;
  readOnly: ReadOnlyDesign | undefined;
}) {
  const { authed, isAdmin } = useSession();
  const scope = useOrgScope();
  const canPublish =
    (scope.membership?.capabilities.includes('templates:publish') ?? false) &&
    (t.orgId !== null || isAdmin);
  const key = draftKey(authed?.user.id ?? 'anonymous', t.orgId, t.id);
  // Read once on open. Saving and activating refetch the template and rewrite the draft
  // under a newer base; re-reading storage then would raise a false stale-draft prompt.
  const [initial] = useState(() => (readOnly ? null : loadDraft(key)));
  const [answer, setAnswer] = useState<'ask' | 'restore' | 'done'>('ask');
  const older = initial && initial.base !== version.version ? initial : null;
  const fresh = initial && initial.base === version.version ? initial.doc : null;
  const asking = older !== null && answer === 'ask';
  const prompt = asking ? (
    <Callout
      className="mb-4"
      tone="info"
      actions={
        <>
          <Button size="sm" onClick={() => setAnswer(loadDraft(key) ? 'restore' : 'done')}>
            Restore
          </Button>
          <Button
            size="sm"
            variant="outline"
            onClick={() => {
              clearDraft(key);
              setAnswer('done');
            }}
          >
            Discard
          </Button>
        </>
      }
    >
      You have an unsaved draft from an older version of this template.
    </Callout>
  ) : null;
  // Keep URLs root-relative; the card rejects absolute HTTP asset URLs.
  return (
    <Designer
      key={`${t.id}:${answer === 'restore' ? 'restore' : 'open'}`}
      template={t}
      canPublish={canPublish}
      selectedOrg={scope.orgId}
      draftKey={key}
      base={{ version: version.version, doc: base }}
      draft={fresh ?? (older && answer === 'restore' ? older.doc : null)}
      assetBase={(version) =>
        `/api/v1/templates/${encodeURIComponent(t.id)}/versions/${encodeURIComponent(version)}/assets${scope.orgId ? `?orgId=${encodeURIComponent(scope.orgId)}` : ''}`
      }
      prompt={prompt}
      {...(readOnly ? { readOnly } : {})}
    />
  );
}
