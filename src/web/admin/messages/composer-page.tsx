import { useNavigate } from '@tanstack/react-router';
import { useEffect, useMemo, useRef, useState } from 'react';
import { useDebounced } from '../../lib/debounce.ts';
import { BELOW_LG, useMediaQuery } from '../../lib/media.ts';
import { useOrgScope } from '../../lib/org-filter.tsx';
import { useOrgOptions } from '../../lib/search.ts';
import {
  Button,
  Card,
  CardBody,
  CardHeader,
  EntityPicker,
  Form,
  FormField,
  PageHeader,
  SegmentedControl,
  TwoPane,
  toast,
  UnsavedChangesDialog,
  useFormErrors,
  useUnsavedChangesGuard,
} from '../../ui/index.ts';
import { useTemplates } from '../templates/api.ts';
import { useAudienceCount, useBroadcast } from './api.ts';
import { AudienceSection, useTemplateDetails } from './audience.tsx';
import { ComposePreview } from './compose-preview.tsx';
import { ChangeSection, MessageSection, WhenSection } from './compose-sections.tsx';
import { atMs, type ComposerState, INITIAL, stateOfBroadcast, targetOf } from './composer-state.ts';
import { useComposerSubmit } from './composer-submit.ts';
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
  const navigate = useNavigate();
  const scope = useOrgScope().orgId;
  const orgs = useOrgOptions();
  const active = useMemo(
    () => (orgs.data?.items ?? []).filter((o) => o.status === 'active'),
    [orgs.data],
  );
  const [picked, setPicked] = useState<string | undefined>(scope);
  useEffect(() => {
    if (!picked && active.length === 1) setPicked(active[0]?.id);
  }, [picked, active]);
  const found = useBroadcast(from);
  const draft = found.data?.state === 'draft' ? found.data : undefined;
  const orgId = draft?.orgId ?? scope ?? picked;
  const org = active.find((o) => o.id === orgId);

  const [state, setState] = useState<ComposerState>({ ...INITIAL, kind: kind ?? 'message' });
  const change = (patch: Partial<ComposerState>) => setState((s) => ({ ...s, ...patch }));
  const [loaded, setLoaded] = useState<string>();
  useEffect(() => {
    if (draft && loaded !== draft.id) {
      setLoaded(draft.id);
      setState(stateOfBroadcast(draft));
    }
  }, [draft, loaded]);
  // Another organization has other templates: nothing chosen for the last one carries over.
  const lastOrg = useRef(orgId);
  useEffect(() => {
    if (lastOrg.current && lastOrg.current !== orgId)
      setState((s) => ({ ...s, templateIds: [], fields: [], values: {} }));
    lastOrg.current = orgId;
  }, [orgId]);
  const templates = useTemplates({ orgId }, Boolean(orgId));
  const usable = useMemo(
    () => (templates.data?.items ?? []).filter((t) => t.status === 'active' && t.activeVersion),
    [templates.data],
  );
  const details = useTemplateDetails(usable);
  const chosen = state.templateIds.flatMap((id) => details.get(id) ?? []);
  const settledQ = useDebounced(state.q);
  const count = useAudienceCount(orgId, targetOf({ ...state, q: settledQ }));
  const [ask, setAsk] = useState(false);
  const wide = !useMediaQuery(BELOW_LG);

  const at = atMs(state);
  const text = state.message.trim();
  const checks = useFormErrors({
    org: orgId ? undefined : 'Choose an organization.',
    templates: state.templateIds.length ? undefined : 'Choose at least one template.',
    message: state.kind === 'message' && !state.clearing && !text ? 'Write a message.' : undefined,
    fields:
      state.kind === 'change' && state.fields.length === 0 ? 'Choose what changes.' : undefined,
    when:
      state.when === 'later' && (at === undefined || at <= Date.now())
        ? 'Pick a time in the future.'
        : undefined,
  });
  const { submit, sentId, pending } = useComposerSubmit(orgId, state, at, draft);
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
    Boolean(orgId) &&
    state.templateIds.length > 0 &&
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
              {scope || active.length === 1 ? null : (
                <FormField label="Organization" error={checks.errors.org}>
                  {(control) => (
                    <EntityPicker
                      {...control}
                      kind="org"
                      value={orgId}
                      placeholder="Choose an organization"
                      onValueChange={setPicked}
                    />
                  )}
                </FormField>
              )}
            </CardBody>
          </Card>
          <Card>
            <CardHeader title="Audience" />
            <CardBody>
              <AudienceSection
                orgId={orgId}
                state={state}
                onChange={change}
                templates={usable}
                loading={templates.isPending && Boolean(orgId)}
                details={details}
                count={count}
                error={checks.errors.templates}
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
