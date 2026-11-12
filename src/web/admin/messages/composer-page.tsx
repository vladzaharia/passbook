import { useQuery } from '@tanstack/react-query';
import { useNavigate } from '@tanstack/react-router';
import { useEffect, useMemo, useState } from 'react';
import type { BroadcastDto } from '@/shared/contracts/broadcasts.ts';
import { useDebounced } from '../../lib/debounce.ts';
import { isApiError } from '../../lib/errors.ts';
import { BELOW_LG, useMediaQuery } from '../../lib/media.ts';
import { useOrgScope } from '../../lib/org-filter.tsx';
import { useOrgOptions } from '../../lib/search.ts';
import {
  Button,
  Card,
  CardBody,
  CardHeader,
  DetailNotFound,
  detailError,
  EmptyState,
  ErrorState,
  Form,
  PageHeader,
  SegmentedControl,
  SkeletonDetail,
  TwoPane,
  toast,
  UnsavedChangesDialog,
  useFormErrors,
  useUnsavedChangesGuard,
} from '../../ui/index.ts';
import { ForbiddenPage } from '../../ui/layout/error-pages.tsx';
import { useTemplates } from '../templates/api.ts';
import { broadcastQuery, useAudienceCount } from './api.ts';
import { AudienceSection, useTemplateDetails } from './audience.tsx';
import { ComposePreview } from './compose-preview.tsx';
import { ChangeSection, MessageSection, WhenSection } from './compose-sections.tsx';
import { atMs, type ComposerState, INITIAL, stateOfBroadcast, targetOf } from './composer-state.ts';
import { useComposerSubmit } from './composer-submit.ts';
import { useAudienceEventName } from './event-name.ts';
import { SendConfirm } from './send-confirm.tsx';

const FORM_ID = 'compose-message';

export function ComposerPage({
  kind,
  from,
}: {
  kind?: 'message' | 'change' | undefined;
  /** A saved draft to edit. */
  from?: string | undefined;
}) {
  const scope = useOrgScope();
  const orgId = !scope.isLoading && !scope.isError ? scope.orgId : undefined;
  const canOperate = scope.membership?.capabilities.includes('messages:manage') === true;
  const found = useQuery({
    ...broadcastQuery(from ?? ''),
    enabled: (query) =>
      Boolean(
        from && orgId && canOperate && (!query.state.data || query.state.data.orgId === orgId),
      ),
  });
  const b = found.data;
  const header = (
    <PageHeader
      title="Message"
      breadcrumbs={[{ label: 'Messages', to: '/admin/messages' }, { label: 'Message' }]}
    />
  );

  if (scope.isLoading) return <SkeletonDetail label="Loading organization access" />;
  if (scope.isError)
    return <ErrorState subject="organization access" error={scope.error} onRetry={scope.refetch} />;
  if (!orgId)
    return (
      <EmptyState
        heading
        art="building"
        title="Choose an organization"
        description="Choose an organization in the top bar to continue."
      />
    );
  if (!canOperate) return <ForbiddenPage />;
  if (from && b && b.orgId !== orgId)
    return (
      <>
        {header}
        <DetailNotFound entity="broadcast" to="/admin/messages" />
      </>
    );
  if (
    from &&
    found.isError &&
    (!b || (isApiError(found.error) && (found.error.isForbidden || found.error.isNotFound)))
  )
    return detailError(found, { entity: 'broadcast', to: '/admin/messages', header });
  if (from && !b)
    return (
      <>
        {header}
        <SkeletonDetail label="Loading message" />
      </>
    );
  const draft = b?.state === 'draft' ? b : undefined;
  return (
    <ComposerForm
      key={JSON.stringify([orgId, from ?? null])}
      kind={kind}
      orgId={orgId}
      draft={draft}
    />
  );
}

function ComposerForm({
  kind,
  orgId,
  draft,
}: {
  kind: 'message' | 'change' | undefined;
  orgId: string;
  draft: BroadcastDto | undefined;
}) {
  const navigate = useNavigate();
  const orgs = useOrgOptions();
  const org = orgs.data?.items.find((o) => o.id === orgId);
  const [state, setState] = useState<ComposerState>(() =>
    draft ? stateOfBroadcast(draft) : { ...INITIAL, kind: kind ?? 'message' },
  );
  const change = (patch: Partial<ComposerState>) => setState((s) => ({ ...s, ...patch }));
  const templates = useTemplates({ orgId });
  const usable = useMemo(
    () =>
      (templates.data?.items ?? []).filter(
        (t) => (t.orgId === null || t.orgId === orgId) && t.status === 'active' && t.activeVersion,
      ),
    [orgId, templates.data],
  );
  const details = useTemplateDetails(usable, orgId);
  const chosen = state.templateIds.flatMap((id) => details.get(id) ?? []);
  const settledQ = useDebounced(state.q);
  const count = useAudienceCount(orgId, targetOf({ ...state, q: settledQ }));
  const [ask, setAsk] = useState(false);
  const wide = !useMediaQuery(BELOW_LG);

  const at = atMs(state);
  const text = state.message.trim();
  const checks = useFormErrors({
    templates: state.templateIds.length ? undefined : 'Choose at least one template.',
    scan:
      (state.scanKind === 'checkedIn' || state.scanKind === 'notCheckedIn') && !state.scanEventId
        ? 'Choose an event.'
        : undefined,
    message: state.kind === 'message' && !state.clearing && !text ? 'Write a message.' : undefined,
    fields:
      state.kind === 'change' && state.fields.length === 0 ? 'Choose what changes.' : undefined,
    when:
      state.when === 'later' && (at === undefined || at <= Date.now())
        ? 'Pick a time in the future.'
        : undefined,
  });
  const { submit, sentId, pending } = useComposerSubmit(orgId, state, at, draft);
  const eventName = useAudienceEventName(orgId, state.scanEventId || undefined);
  const dirty = draft
    ? JSON.stringify(state) !== JSON.stringify(stateOfBroadcast(draft))
    : state.message !== '' || state.templateIds.length > 0 || state.fields.length > 0;
  const guard = useUnsavedChangesGuard(dirty && !sentId);

  // Navigates once the guard has re-rendered clean; navigating in submit itself was blocked.
  useEffect(() => {
    if (sentId)
      void navigate({
        to: '/admin/messages/$broadcastId',
        params: { broadcastId: sentId },
        replace: true,
      });
  }, [sentId, navigate]);
  const send = state.when === 'later' ? 'schedule' : 'now';
  const canDraft =
    state.templateIds.length > 0 &&
    !(
      (state.scanKind === 'checkedIn' || state.scanKind === 'notCheckedIn') &&
      !state.scanEventId
    ) &&
    (state.kind === 'message' ? state.clearing || Boolean(text) : state.fields.length > 0);
  const quiet = !state.notify || state.clearing;
  const title = draft ? 'Edit draft' : state.kind === 'message' ? 'New message' : 'New change';
  const preview = org ? (
    <ComposePreview
      org={{ id: org.id, name: org.name, accent: org.branding.accent ?? null }}
      state={state}
      detail={chosen[0]}
      silent={quiet}
    />
  ) : null;

  return (
    <>
      <PageHeader
        title={title}
        breadcrumbs={[
          { label: 'Messages', to: '/admin/messages' },
          { label: draft ? 'Edit' : 'New' },
        ]}
      />
      <TwoPane asideFrom="lg" stickyAside asideLabel="Preview" aside={wide ? preview : null}>
        <Form
          id={FORM_ID}
          {...checks.form}
          onValid={() => setAsk(true)}
          className="flex min-w-0 flex-col gap-6"
        >
          <Card>
            <CardBody className="flex flex-col gap-4">
              <SegmentedControl
                label="Type"
                options={[
                  { value: 'message', label: 'Message' },
                  { value: 'change', label: 'Change' },
                ]}
                value={state.kind}
                onValueChange={(next) =>
                  change({ kind: next, templateIds: [], fields: [], values: {}, clearing: false })
                }
              />
            </CardBody>
          </Card>
          <Card>
            <CardHeader title="Audience & scan filters" />
            <CardBody>
              <AudienceSection
                orgId={orgId}
                state={state}
                onChange={change}
                templates={usable}
                loading={templates.isPending}
                details={details}
                count={count}
                error={checks.errors.templates}
                scanError={checks.errors.scan}
              />
            </CardBody>
          </Card>
          <Card>
            <CardHeader title={state.kind === 'message' ? 'Message' : 'Changes'} />
            <CardBody>
              {state.kind === 'message' ? (
                <MessageSection state={state} onChange={change} error={checks.errors.message} />
              ) : (
                <ChangeSection
                  state={state}
                  onChange={change}
                  details={chosen}
                  error={checks.errors.fields}
                />
              )}
            </CardBody>
          </Card>
          {wide ? null : preview}
          <Card>
            <CardHeader title="When" />
            <CardBody>
              <WhenSection state={state} onChange={change} error={checks.errors.when} />
            </CardBody>
          </Card>
          <div className="flex flex-wrap items-center gap-2">
            <Button type="submit" loading={pending && !ask}>
              {state.when === 'later' ? 'Schedule' : 'Send now'}
            </Button>
            <Button
              type="button"
              variant="outline"
              loading={pending && !ask}
              disabled={!canDraft}
              onClick={() =>
                void submit('draft').catch((e: unknown) => toast.error(e, 'Could not save'))
              }
            >
              Save draft
            </Button>
            <Button
              type="button"
              variant="ghost"
              onClick={() => void navigate({ to: '/admin/messages' })}
            >
              Cancel
            </Button>
          </div>
        </Form>
      </TwoPane>
      <SendConfirm
        open={ask}
        onOpenChange={setAsk}
        audience={[
          chosen.map((t) => t.name).join(', ') || state.templateIds.join(', '),
          state.holder === 'any' ? 'Any holder' : state.holder,
          state.onDevice ? 'Device registration required' : 'All devices',
          state.q ? `Matching “${state.q}”` : '',
          state.scanKind === 'checkedIn' || state.scanKind === 'notCheckedIn'
            ? `${state.scanKind === 'checkedIn' ? 'Checked in' : 'Not checked in'} to ${eventName ?? 'an event'}`
            : state.scanKind === 'noScan30'
              ? 'No completed scan in 30 days'
              : state.scanKind === 'noScan90'
                ? 'No completed scan in 90 days'
                : 'Any scan activity',
        ]
          .filter(Boolean)
          .join(' · ')}
        kind={state.kind}
        count={count}
        settled={settledQ === state.q}
        quiet={quiet}
        at={at}
        later={state.when === 'later'}
        onConfirm={() => submit(send)}
      />
      <UnsavedChangesDialog blocker={guard} />
    </>
  );
}
