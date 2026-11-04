import { Link } from '@tanstack/react-router';
import { useMemo, useState } from 'react';
import type { z } from 'zod';
import type {
  TemplateDetailSchema,
  TemplateVersionDetailSchema,
} from '@/shared/contracts/templates.ts';
import { ACTION_ICON } from '../../../lib/action-icons.ts';
import { Button, Callout, detailError, PageHeader, SkeletonDetail } from '../../../ui/index.ts';
import { useTemplate } from '../api.ts';
import { DuplicateDialog } from '../template-dialogs.tsx';
import { useBaseVersion } from './api.ts';
import { Designer } from './designer.tsx';
import { clearDraft, loadDraft } from './drafts.ts';
import type { DesignDoc } from './model.ts';

type Template = z.infer<typeof TemplateDetailSchema>;
type Version = z.infer<typeof TemplateVersionDetailSchema>;

const assetBaseOf = (id: string) => (version: string) =>
  `${typeof location === 'undefined' ? '' : location.origin}/api/v1/templates/${encodeURIComponent(id)}/versions/${encodeURIComponent(version)}/assets`;

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
  const template = useTemplate(templateId);
  const crumbs = [
    { label: 'Templates', to: '/admin/templates' },
    { label: template.data?.name ?? 'Template', to: `/admin/templates/${templateId}` },
    { label: 'Design' },
  ];
  if (template.isError) {
    return detailError(template, {
      entity: 'template',
      to: '/admin/templates',
      header: <PageHeader title="Design" breadcrumbs={crumbs} />,
    });
  }
  if (!template.data) {
    return (
      <>
        <PageHeader title="Design" breadcrumbs={crumbs} />
        <SkeletonDetail label="Loading template" />
      </>
    );
  }
  return <Gate template={template.data} crumbs={crumbs} />;
}

function Gate({
  template: t,
  crumbs,
}: {
  template: Template;
  crumbs: { label: string; to?: string }[];
}) {
  const [duplicate, setDuplicate] = useState(false);
  if (t.origin === 'baked' || t.status !== 'active') {
    return (
      <>
        <PageHeader title={`Design ${t.name}`} breadcrumbs={crumbs} />
        <Callout
          tone="info"
          actions={
            t.origin === 'baked' ? (
              <Button
                iconStart={<ACTION_ICON.duplicate aria-hidden />}
                onClick={() => setDuplicate(true)}
              >
                Duplicate to edit
              </Button>
            ) : (
              <Button asChild variant="outline">
                <Link to="/admin/templates/$templateId" params={{ templateId: t.id }}>
                  Open template
                </Link>
              </Button>
            )
          }
        >
          {t.origin === 'baked'
            ? 'Built-in templates are read only. Duplicate it to design your own.'
            : 'Restore this template to change it.'}
        </Callout>
        <DuplicateDialog
          key={String(duplicate)}
          template={t}
          open={duplicate}
          onOpenChange={setDuplicate}
        />
      </>
    );
  }
  return <Loaded key={t.id} template={t} crumbs={crumbs} />;
}

function Loaded({
  template: t,
  crumbs,
}: {
  template: Template;
  crumbs: { label: string; to?: string }[];
}) {
  // The version the designer opened with. Activating or another admin's upload moves
  // `activeVersion`, but must not remount the designer or drop its edits.
  const [opened] = useState(t.activeVersion);
  const [stale, setStale] = useState<'ask' | 'restore' | 'discard'>('ask');
  const version = useBaseVersion(t.id, opened);
  const base = useMemo(() => (version.data ? docOf(version.data) : null), [version.data]);
  if (version.isError) {
    return detailError(version, {
      entity: 'template',
      to: `/admin/templates/${t.id}`,
      header: <PageHeader title={`Design ${t.name}`} breadcrumbs={crumbs} />,
    });
  }
  if (!base || !version.data) {
    return (
      <>
        <PageHeader title={`Design ${t.name}`} breadcrumbs={crumbs} />
        <SkeletonDetail label="Loading template" />
      </>
    );
  }
  const draft = loadDraft(t.id);
  const older = draft && draft.base !== version.data.version ? draft : null;
  const asking = older && stale === 'ask';
  const fresh = draft && draft.base === version.data.version ? draft.doc : null;
  return (
    <>
      {asking ? (
        <Callout
          className="mb-4"
          tone="info"
          actions={
            <>
              <Button size="sm" onClick={() => setStale('restore')}>
                Restore
              </Button>
              <Button
                size="sm"
                variant="outline"
                onClick={() => {
                  clearDraft(t.id);
                  setStale('discard');
                }}
              >
                Discard
              </Button>
            </>
          }
        >
          You have an unsaved draft from an older version of this template.
        </Callout>
      ) : null}
      <Designer
        key={`${t.id}:${asking ? 'ask' : stale}`}
        templateId={t.id}
        name={t.name}
        base={{ version: version.data.version, doc: base }}
        draft={fresh ?? (older && stale === 'restore' ? older.doc : null)}
        assetBase={assetBaseOf(t.id)}
      />
    </>
  );
}
