import { Link } from '@tanstack/react-router';
import { useMemo, useState } from 'react';
import type { z } from 'zod';
import type {
  TemplateDetailSchema,
  TemplateVersionDetailSchema,
} from '@/shared/contracts/templates.ts';
import { ACTION_ICON } from '../../../lib/action-icons.ts';
import { useSession } from '../../../lib/session.ts';
import { Button, Callout, detailError, PageHeader } from '../../../ui/index.ts';
import { useTemplate, useTemplatePreview } from '../api.ts';
import { DuplicateDialog } from '../template-dialogs.tsx';
import { useBaseVersion } from './api.ts';
import { Designer, type ReadOnlyDesign } from './designer.tsx';
import { DesignerSkeleton } from './designer-skeleton.tsx';
import { clearDraft, draftKey, loadDraft } from './drafts.ts';
import type { DesignDoc } from './model.ts';

type Template = z.infer<typeof TemplateDetailSchema>;
type Version = z.infer<typeof TemplateVersionDetailSchema>;
type Crumbs = { label: string; to?: string }[];

/** Root-relative: an absolute http URL is refused by the card's image check. */
const assetBaseOf = (id: string) => (version: string) =>
  `/api/v1/templates/${encodeURIComponent(id)}/versions/${encodeURIComponent(version)}/assets`;

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
  const title = template.data?.name ?? 'Design';
  if (template.isError) {
    return detailError(template, {
      entity: 'template',
      to: '/admin/templates',
      header: <PageHeader title={title} breadcrumbs={crumbs} />,
    });
  }
  if (!template.data) {
    return (
      <>
        <PageHeader title={title} breadcrumbs={crumbs} />
        <DesignerSkeleton />
      </>
    );
  }
  return <Loaded key={template.data.id} template={template.data} crumbs={crumbs} />;
}

/** Why a template cannot be designed, and the way out. */
function ReadOnlyNotice({ template: t }: { template: Template }) {
  const [duplicate, setDuplicate] = useState(false);
  const baked = t.origin === 'baked';
  return (
    <>
      <Callout
        className="mb-4"
        tone="info"
        actions={
          baked ? (
            <Button
              size="sm"
              iconStart={<ACTION_ICON.duplicate aria-hidden />}
              onClick={() => setDuplicate(true)}
            >
              Duplicate
            </Button>
          ) : (
            <Button asChild size="sm" variant="outline">
              <Link to="/admin/templates/$templateId" params={{ templateId: t.id }}>
                Open template
              </Link>
            </Button>
          )
        }
      >
        {baked
          ? 'This template is read only. Duplicate it to design your own.'
          : 'This template is archived. Restore it to change it.'}
      </Callout>
      {baked ? (
        <DuplicateDialog
          key={String(duplicate)}
          template={t}
          open={duplicate}
          onOpenChange={setDuplicate}
          to="design"
        />
      ) : null}
    </>
  );
}

function Loaded({ template: t, crumbs }: { template: Template; crumbs: Crumbs }) {
  // The version the designer opened with. Activating or another admin's upload moves
  // `activeVersion`, but must not remount the designer or drop its edits.
  const [opened] = useState(t.activeVersion);
  const version = useBaseVersion(t.id, opened);
  const locked = t.origin === 'baked' || t.status !== 'active';
  const preview = useTemplatePreview(locked ? t.id : '');
  const base = useMemo(() => (version.data ? docOf(version.data) : null), [version.data]);
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
        notice: <ReadOnlyNotice template={t} />,
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
  const { authed } = useSession();
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
  return (
    <Designer
      key={`${t.id}:${answer === 'restore' ? 'restore' : 'open'}`}
      template={t}
      draftKey={key}
      base={{ version: version.version, doc: base }}
      draft={fresh ?? (older && answer === 'restore' ? older.doc : null)}
      assetBase={assetBaseOf(t.id)}
      prompt={prompt}
      {...(readOnly ? { readOnly } : {})}
    />
  );
}
