import { useQuery } from '@tanstack/react-query';
import { useMemo, useState } from 'react';
import type { z } from 'zod';
import {
  PreviewResponseSchema,
  type TemplateDetailSchema,
  type TemplateVersionDetailSchema,
} from '@/shared/contracts/templates.ts';
import { WB_DESIGN } from '@/shared/copy/workbench-design.ts';
import { docOf, useBaseVersion } from '../../admin/templates/designer/api.ts';
import type { DesignSearch } from '../../admin/templates/designer/design-search.ts';
import { Designer, type ReadOnlyDesign } from '../../admin/templates/designer/designer.tsx';
import { DesignerSkeleton } from '../../admin/templates/designer/designer-skeleton.tsx';
import { clearDraft, draftKey, loadDraft } from '../../admin/templates/designer/drafts.ts';
import { PlaceLink, useDesignerHost, useHostKey } from '../../admin/templates/designer/host.tsx';
import { useSession } from '../../lib/session.ts';
import { Button } from '../../ui/button.tsx';
import { Callout } from '../../ui/callout.tsx';
import { detailError } from '../../ui/detail-error.tsx';
import { EmptyState } from '../../ui/empty-state.tsx';
import { useToolApi } from '../host/tool-scope.ts';
import { TemplateProvider } from './template-context.tsx';

type Template = z.infer<typeof TemplateDetailSchema>;
type Version = z.infer<typeof TemplateVersionDetailSchema>;

export interface DesignView {
  view: DesignSearch;
  onView: (next: DesignSearch) => void;
}

/** The built pass of a version a person cannot edit, through the token client. */
function useLockedPass(template: Template, version: string, enabled: boolean) {
  const api = useToolApi();
  const hostKey = useHostKey();
  const { orgId } = useDesignerHost();
  return useQuery({
    queryKey: [
      'admin',
      'templates',
      'detail',
      template.id,
      orgId ?? null,
      'locked',
      version,
      ...hostKey,
    ],
    queryFn: ({ signal }) =>
      api.post(
        `/api/v1/templates/${encodeURIComponent(template.id)}/preview`,
        PreviewResponseSchema,
        { version, ...(orgId ? { orgId } : {}) },
        { ...(orgId ? { query: { orgId } } : {}), signal },
      ),
    enabled,
  });
}

/** The template's newest saved version, opened once so another person's release does not move it. */
function openedVersion(t: Template): string | null {
  if (t.activeVersion) return t.activeVersion;
  let latest: Template['versions'][number] | undefined;
  for (const v of t.versions) if (!latest || v.createdAt > latest.createdAt) latest = v;
  return latest?.version ?? null;
}

/** A template of the org, in the designer: editable when it is the org's own and active. */
export function DesignLoaded({ template: t, view, onView }: { template: Template } & DesignView) {
  const [opened] = useState(() => openedVersion(t));
  const { orgId, allows } = useDesignerHost();
  const version = useBaseVersion(t.id, opened);
  const shared = t.orgId === null;
  const locked = t.origin === 'baked' || t.status !== 'active' || shared || !allows.edit;
  const lockedPass = useLockedPass(t, opened ?? '', locked && Boolean(opened));
  const base = useMemo(() => (version.data ? docOf(version.data) : null), [version.data]);
  if (!opened) return <EmptyState art="template" title={WB_DESIGN.states.noVersions} />;
  if (version.isError) return detailError(version, { entity: 'template', to: '/workbench' });
  if (!base || !version.data || (locked && !lockedPass.data)) return <DesignerSkeleton />;
  const readOnly: ReadOnlyDesign | undefined = locked
    ? {
        notice: (
          <Callout className="mb-4" tone="info">
            {shared ? WB_DESIGN.states.shared : WB_DESIGN.states.locked}{' '}
            <PlaceLink place={{ to: 'template', templateId: t.id }} className="underline">
              {WB_DESIGN.states.openAdmin}
            </PlaceLink>
          </Callout>
        ),
        passJson: lockedPass.data?.passJson ?? null,
        issues: (version.data as Version).report.issues,
      }
    : undefined;
  return (
    <TemplateProvider value={{ id: t.id, name: t.name }}>
      <DesignReady
        template={t}
        version={version.data}
        base={base}
        readOnly={readOnly}
        orgId={orgId}
        view={view}
        onView={onView}
      />
    </TemplateProvider>
  );
}

function DesignReady({
  template: t,
  version,
  base,
  readOnly,
  orgId,
  view,
  onView,
}: {
  template: Template;
  version: Version;
  base: ReturnType<typeof docOf>;
  readOnly: ReadOnlyDesign | undefined;
  orgId: string | undefined;
} & DesignView) {
  const { authed } = useSession();
  const key = draftKey(authed?.user.id ?? 'anonymous', t.orgId, t.id);
  // Read once on open: saving refetches the template and rewrites the draft under a newer base.
  const [initial] = useState(() => (readOnly ? null : loadDraft(key)));
  const [answer, setAnswer] = useState<'ask' | 'restore' | 'done'>('ask');
  const older = initial && initial.base !== version.version ? initial : null;
  const fresh = initial && initial.base === version.version ? initial.doc : null;
  const prompt =
    older !== null && answer === 'ask' ? (
      <Callout
        className="mb-4"
        tone="info"
        actions={
          <>
            <Button size="sm" onClick={() => setAnswer(loadDraft(key) ? 'restore' : 'done')}>
              {WB_DESIGN.states.restore}
            </Button>
            <Button
              size="sm"
              variant="outline"
              onClick={() => {
                clearDraft(key);
                setAnswer('done');
              }}
            >
              {WB_DESIGN.states.discard}
            </Button>
          </>
        }
      >
        {WB_DESIGN.states.draftOlder}
      </Callout>
    ) : null;
  return (
    <Designer
      key={`${t.id}:${answer === 'restore' ? 'restore' : 'open'}`}
      template={t}
      draftKey={key}
      base={{ version: version.version, doc: base }}
      draft={fresh ?? (older && answer === 'restore' ? older.doc : null)}
      assetBase={(v) =>
        `/api/v1/templates/${encodeURIComponent(t.id)}/versions/${encodeURIComponent(v)}/assets${orgId ? `?orgId=${encodeURIComponent(orgId)}` : ''}`
      }
      prompt={prompt}
      {...(readOnly ? { readOnly } : {})}
      view={view}
      onView={(mode, wallet) => onView(mode === 'wallets' ? { mode, wallet } : {})}
    />
  );
}
