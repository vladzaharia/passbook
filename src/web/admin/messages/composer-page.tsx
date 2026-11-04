import { useNavigate } from '@tanstack/react-router';
import { useEffect, useMemo, useState } from 'react';
import { useDebounced } from '../../lib/debounce.ts';
import { formatCount, formatDateTime } from '../../lib/format.ts';
import { useOrgScope } from '../../lib/org-filter.tsx';
import { useOrgOptions } from '../../lib/search.ts';
import {
  Button,
  Card,
  CardBody,
  CardHeader,
  ConfirmDialog,
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
import { useAudienceCount, useBroadcastActions } from './api.ts';
import { AudienceSection, useTemplateDetails } from './audience.tsx';
import { ComposePreview } from './compose-preview.tsx';
import { ChangeSection, MessageSection, WhenSection } from './compose-sections.tsx';
import { atMs, bodyOf, type ComposerState, INITIAL, targetOf } from './composer-state.ts';

const FORM_ID = 'compose-message';

export function ComposerPage({ kind }: { kind?: 'message' | 'change' | undefined }) {
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
  const orgId = scope ?? picked;
  const org = active.find((o) => o.id === orgId);

  const [state, setState] = useState<ComposerState>({ ...INITIAL, kind: kind ?? 'message' });
  const change = (patch: Partial<ComposerState>) => setState((s) => ({ ...s, ...patch }));
  const templates = useTemplates({ orgId }, Boolean(orgId));
  const usable = useMemo(
    () => (templates.data?.items ?? []).filter((t) => t.status === 'active' && t.activeVersion),
    [templates.data],
  );
  const details = useTemplateDetails(usable);
  const chosen = state.templateIds.flatMap((id) => details.get(id) ?? []);
  const settledQ = useDebounced(state.q);
  const count = useAudienceCount(orgId, targetOf({ ...state, q: settledQ }));
  const actions = useBroadcastActions();
  const [ask, setAsk] = useState(false);
  const [sent, setSent] = useState(false);

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
  const dirty =
    !sent && (state.message !== '' || state.templateIds.length > 0 || state.fields.length > 0);
  const guard = useUnsavedChangesGuard(dirty);

  const submit = async (send: 'draft' | 'now' | 'schedule') => {
    if (!orgId) return;
    const body = bodyOf(orgId, state, send, at);
    if (!body) return;
    const made = await actions.create.mutateAsync(body);
    setSent(true);
    toast.success(send === 'draft' ? 'Draft saved' : send === 'now' ? 'Sending' : 'Scheduled');
    void navigate({
      to: '/admin/messages/$broadcastId',
      params: { broadcastId: made.id },
      replace: true,
    });
  };
  const send = state.when === 'later' ? 'schedule' : 'now';
  // A count for an older audience (while the search settles or reloads) is not the count to confirm.
  const counted = count.data !== undefined && !count.isPlaceholderData && settledQ === state.q;
  const targeted = count.data?.targeted ?? 0;
  const noCount = count.isError && count.data === undefined;
  const nothing = counted || noCount;
  const canDraft =
    Boolean(orgId) &&
    state.templateIds.length > 0 &&
    (state.kind === 'message' ? state.clearing || Boolean(text) : state.fields.length > 0);
  const quiet = !state.notify || state.clearing || (state.kind === 'message' && !text);
  const title = state.kind === 'message' ? 'New message' : 'New scheduled change';

  return (
    <>
      <PageHeader
        title={title}
        breadcrumbs={[{ label: 'Messages', to: '/admin/messages' }, { label: 'New' }]}
      />
      <TwoPane
        asideFrom="lg"
        stickyAside
        asideLabel="Preview"
        aside={
          org ? (
            <ComposePreview
              org={{ id: org.id, name: org.name, accent: org.branding.accent ?? null }}
              state={state}
              detail={chosen[0]}
              silent={quiet}
            />
          ) : null
        }
      >
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
                  { value: 'change', label: 'Scheduled change' },
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
                      onValueChange={(id) => {
                        setPicked(id);
                        change({ templateIds: [], fields: [], values: {} });
                      }}
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
          <Card>
            <CardHeader title="When" />
            <CardBody>
              <WhenSection state={state} onChange={change} error={checks.errors.when} />
            </CardBody>
          </Card>
          <div className="flex flex-wrap items-center gap-2">
            <Button type="submit" loading={actions.create.isPending && !ask}>
              {state.when === 'later' ? 'Schedule' : 'Send now'}
            </Button>
            <Button
              type="button"
              variant="outline"
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
      <ConfirmDialog
        open={ask}
        onOpenChange={setAsk}
        title={
          noCount
            ? 'Could not count the passes'
            : !counted
              ? 'Counting passes'
              : targeted === 0
                ? 'No passes match'
                : state.when === 'later'
                  ? `Schedule for ${formatCount(targeted)} ${targeted === 1 ? 'pass' : 'passes'}?`
                  : `Send to ${formatCount(targeted)} ${targeted === 1 ? 'pass' : 'passes'}?`
        }
        description={
          noCount
            ? 'Close this and try again.'
            : !counted
              ? 'One moment.'
              : targeted === 0
                ? 'Change the audience first.'
                : state.when === 'later' && at !== undefined
                  ? `Goes out ${formatDateTime(at)}. You can cancel until then.`
                  : quiet
                    ? 'The passes update without a notification.'
                    : 'Holders are notified at once.'
        }
        confirmLabel={state.when === 'later' ? 'Schedule' : 'Send'}
        confirmDisabled={!counted}
        hideConfirm={nothing && targeted === 0}
        cancelLabel={nothing && targeted === 0 ? 'Close' : 'Cancel'}
        onConfirm={async () => {
          if (targeted === 0) return;
          await submit(send);
        }}
      />
      <UnsavedChangesDialog blocker={guard} />
    </>
  );
}
