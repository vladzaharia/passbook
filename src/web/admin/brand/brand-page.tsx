import { Link, useNavigate } from '@tanstack/react-router';
import { Copy, ScrollText } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import type { OrgMembership } from '@/shared/contracts/org-membership.ts';
import type { PassSetup, PassSetupPatch } from '@/shared/contracts/pass-setup.ts';
import { PASS_SETUP_COPY } from '@/shared/copy/pass-setup.ts';
import { scanLine } from '@/shared/copy/scan.ts';
import { orgSetupChecks } from '@/shared/org-setup-checks.ts';
import { copyText } from '@/web/lib/clipboard.ts';
import { cn } from '@/web/lib/cn.ts';
import { BELOW_XL, useMediaQuery } from '@/web/lib/media.ts';
import {
  Badge,
  Callout,
  DropdownMenuItem,
  detailError,
  MoreMenu,
  PageHeader,
  SaveBar,
  SkeletonDetail,
  TwoPane,
  toast,
  UnsavedChangesDialog,
  useUnsavedChangesGuard,
} from '@/web/ui/index.ts';
import { brandingUrl } from '../orgs/queries.ts';
import { publishUnsaved } from '../settings/drafts.ts';
import { isSetupChanged, usePassSetup, useSavePassSetup } from './api.ts';
import { BrandCard } from './brand-card.tsx';
import { ChannelsCard } from './channels-card.tsx';
import { ChecksCard } from './checks-card.tsx';
import {
  changeCount,
  type Draft,
  draftErrors,
  draftPatch,
  facts,
  type ImageSlot,
  type StagedImage,
} from './draft.ts';
import { runFix } from './fixes.ts';
import { HolderPreview } from './holder-preview.tsx';
import { PreviewStage, useSample } from './preview-stage.tsx';
import { ReviewDialog } from './review-dialog.tsx';
import { SupportCard } from './support-card.tsx';

const COPY = PASS_SETUP_COPY;
const AREAS = ['brand', 'support', 'channels'] as const;

/** Brand, Support and email, Channels: anchors to the cards, each with its open to-dos. */
function SectionNav({ counts }: { counts: Record<(typeof AREAS)[number], number> }) {
  return (
    <nav aria-label="Sections" className="flex gap-1 overflow-x-auto border-b border-border">
      {AREAS.map((a) => (
        <a
          key={a}
          href={`#${a}`}
          className={cn(
            'inline-flex min-h-11 shrink-0 items-center gap-2 whitespace-nowrap border-b-2 border-transparent px-3 text-sm font-medium text-fg-muted',
            'hover:text-fg-strong focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus',
          )}
        >
          {COPY.areas[a]}
          {counts[a] > 0 ? <Badge tone="warning">{counts[a]}</Badge> : null}
        </a>
      ))}
    </nav>
  );
}

function BrandForm({
  orgId,
  view,
  membership,
  refetch,
}: {
  orgId: string;
  view: PassSetup;
  membership: OrgMembership;
  refetch: () => unknown;
}) {
  const navigate = useNavigate();
  const save = useSavePassSetup(orgId);
  const [draft, setDraft] = useState<Draft>({});
  const [review, setReview] = useState(false);
  const [saves, setSaves] = useState(0);
  const caps = membership.capabilities;
  const canEdit = caps.includes('org:manage');
  const patch = useMemo(() => draftPatch(view, draft), [view, draft]);
  const errors = useMemo(() => draftErrors(view, draft), [view, draft]);
  const dirty = patch !== null || Object.keys(errors).length > 0;
  const guard = useUnsavedChangesGuard(dirty);
  const edit = (p: Partial<Draft>) => setDraft((d) => ({ ...d, ...p }));
  const setImage = (slot: ImageSlot, image: StagedImage | null) =>
    setDraft((d) => ({ ...d, images: { ...d.images, [slot]: image } }));
  const draftFacts = useMemo(() => facts(view, draft), [view, draft]);
  const checks = useMemo(() => orgSetupChecks(draftFacts, Date.now()), [draftFacts]);
  const counts = {
    brand: checks.filter((c) => c.area === 'brand' && c.level !== 'info').length,
    support: checks.filter((c) => c.area === 'support' && c.level !== 'info').length,
    channels: checks.filter((c) => c.area === 'channels' && c.level !== 'info').length,
  };

  // The email preview follows the unsaved support contacts, as the Settings form's did.
  useEffect(() => {
    const unsaved: Record<string, string> = {};
    if (draft.supportEmail !== undefined) unsaved['support.email'] = draft.supportEmail;
    if (draft.supportUrl !== undefined) unsaved['support.url'] = draft.supportUrl;
    publishUnsaved(`org:${orgId}`, 'brand', Object.keys(unsaved).length ? unsaved : null);
    return () => publishUnsaved(`org:${orgId}`, 'brand', null);
  }, [orgId, draft.supportEmail, draft.supportUrl]);

  const image = (slot: 'logo' | 'icon') => {
    const staged = draft.images?.[slot];
    if (staged === null) return undefined;
    if (staged) return { url: staged.url, w: staged.w, h: staged.h };
    const saved = view.brand[slot].value;
    return saved ? { url: brandingUrl(orgId, slot, saved.sha), w: saved.w, h: saved.h } : undefined;
  };
  const sample = useSample(view, draft, image('logo'), image('icon'));
  const request = () => {
    const url = `${window.location.origin}/api/v1/orgs/${encodeURIComponent(orgId)}/pass-setup`;
    const auth = "-H 'authorization: Bearer $PASSBOOK_API_KEY'";
    const text = patch
      ? `curl -X PATCH '${url}' ${auth} -H 'content-type: application/json' -d '${JSON.stringify(patch)}'`
      : `curl '${url}' ${auth}`;
    void copyText(text, 'request');
  };

  function onReview() {
    const bad = document.querySelector<HTMLElement>('#main [aria-invalid="true"]');
    if (Object.keys(errors).length > 0) return bad?.focus();
    setReview(true);
  }

  async function commit(body: PassSetupPatch) {
    try {
      await save.mutateAsync(body);
      setDraft({});
      setSaves((n) => n + 1);
      setReview(false);
      toast.success(COPY.page.saved);
    } catch (cause) {
      if (isSetupChanged(cause)) {
        void refetch();
        setReview(false);
        toast.info(COPY.stale);
        return;
      }
      toast.error(cause, 'Could not save');
    }
  }

  const n = changeCount(patch);
  // Stacked, the preview follows the brand fields it shows instead of pushing them down.
  const compact = useMediaQuery(BELOW_XL);
  const preview = (
    <PreviewStage
      orgId={orgId}
      view={view}
      draft={draft}
      draftFacts={draftFacts}
      sample={sample}
      saves={saves}
    />
  );
  return (
    <>
      <PageHeader
        title={COPY.title}
        meta={
          <span>
            {view.passCount === 0
              ? COPY.page.noPasses
              : view.passCount === 1
                ? COPY.page.passesOne
                : scanLine(COPY.page.passes, { n: view.passCount })}
          </span>
        }
        actions={
          <>
            <HolderPreview source={sample.source} title={COPY.page.previewHolder} />
            <MoreMenu>
              <DropdownMenuItem onSelect={request}>
                <Copy aria-hidden />
                {COPY.page.copyRequest}
              </DropdownMenuItem>
              {caps.includes('audit:read') ? (
                <DropdownMenuItem asChild>
                  <Link to="/admin/o/$orgId/audit" params={{ orgId }}>
                    <ScrollText aria-hidden />
                    {COPY.page.auditLog}
                  </Link>
                </DropdownMenuItem>
              ) : null}
            </MoreMenu>
          </>
        }
      />
      {canEdit ? null : (
        <Callout tone="info" className="mb-6">
          {COPY.page.readOnly}
        </Callout>
      )}
      <TwoPane
        stickyAside
        asideFirst
        aside={
          <>
            <ChecksCard
              checks={checks}
              canFix={canEdit}
              onFix={(c) =>
                runFix(c, {
                  view,
                  draft,
                  edit,
                  openTemplate: (templateId) =>
                    void navigate({
                      to: '/admin/o/$orgId/templates/$templateId',
                      params: { orgId, templateId },
                    }),
                })
              }
            />
            {compact ? null : preview}
          </>
        }
      >
        <SectionNav counts={counts} />
        <BrandCard
          orgId={orgId}
          view={view}
          draft={draft}
          canEdit={canEdit}
          errors={errors}
          edit={edit}
          setImage={setImage}
        />
        {compact ? preview : null}
        <SupportCard orgId={orgId} view={view} draft={draft} canEdit={canEdit} edit={edit} />
        <ChannelsCard
          orgId={orgId}
          view={view}
          draftFacts={draftFacts}
          draft={draft}
          edit={edit}
          canEdit={canEdit}
          canManageApple={canEdit}
          canOperatePasses={caps.includes('passes:operate')}
          accounts={
            caps.includes('integrations:manage')
              ? 'manage'
              : caps.includes('integrations:read')
                ? 'read'
                : 'none'
          }
        />
      </TwoPane>
      {canEdit ? (
        <SaveBar
          dirty={dirty}
          saving={save.isPending}
          paused={save.isPaused}
          saveLabel={COPY.page.review}
          onSave={onReview}
          onDiscard={() => setDraft({})}
          extra={
            <span className="text-sm text-fg-muted">
              {n === 1 ? COPY.page.changesOne : scanLine(COPY.page.changes, { n })}
            </span>
          }
        />
      ) : null}
      <ReviewDialog
        orgId={orgId}
        patch={patch}
        open={review}
        onOpenChange={setReview}
        saving={save.isPending}
        onConfirm={() => patch && void commit(patch)}
      />
      <UnsavedChangesDialog blocker={guard} />
    </>
  );
}

/** Mounted behind the org gate, which admits an org:read membership. */
export function BrandPage({ orgId, membership }: { orgId: string; membership: OrgMembership }) {
  const query = usePassSetup(orgId);
  if (query.isPending)
    return (
      <>
        <PageHeader title={COPY.title} />
        <SkeletonDetail label={COPY.page.loading} />
      </>
    );
  if (!query.data)
    return detailError(query, {
      entity: 'org',
      to: '/admin',
      header: <PageHeader title={COPY.title} />,
    });
  return (
    <BrandForm
      key={orgId}
      orgId={orgId}
      view={query.data}
      membership={membership}
      refetch={query.refetch}
    />
  );
}
