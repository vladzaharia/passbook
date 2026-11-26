import { type ReactNode, useEffect, useRef, useState } from 'react';
import type { ScanningSession } from '@/shared/contracts/scanning-sessions.ts';
import { useSeededZone } from '@/web/admin/settings/use-org-time-zone.ts';
import { isApiError } from '@/web/lib/errors.ts';
import { useMode } from '@/web/lib/mode.ts';
import { useOrgScope } from '@/web/lib/org-filter.tsx';
import { Button, Callout, FormField, Select, useWizard, WizardDialog } from '@/web/ui/index.ts';
import { useCreateSession, useUpdateSession } from './api.ts';
import { emptySessionDraft, type SessionDraft, sessionBody, sessionDraft } from './draft.ts';
import { SessionFields } from './session-fields.tsx';
import { SessionReview } from './session-review.tsx';
import {
  SESSION_FIELD_STEP,
  SESSION_HINTS,
  SESSION_STEPS,
  type SessionBodyId,
  sessionErrors,
  sessionSummaries,
} from './session-steps.ts';

function withOrganization(draft: SessionDraft, orgId: string): SessionDraft {
  if (draft.orgId === orgId) return draft;
  const { eventId: _eventId, ...checkIn } = draft.checkIn;
  return {
    ...draft,
    orgId,
    eventIds: [],
    templateIds: [],
    checkIn,
    zoneIds: draft.zoneIds && [],
  };
}

/** The one wizard for New session, Duplicate and Session rules: only the finish and the lead differ. */
function SessionWizard({
  title,
  edit,
  draft,
  setDraft,
  dirty,
  notice,
  blocked,
  orgName,
  lead,
  finishLabel,
  busy,
  onFinish,
  onClose,
}: {
  title: string;
  edit: boolean;
  draft: SessionDraft;
  setDraft: (update: (d: SessionDraft) => SessionDraft) => void;
  dirty: boolean;
  notice?: ReactNode;
  /** Why the session cannot be saved from this console, else undefined. */
  blocked: string | undefined;
  orgName?: string | undefined;
  /** At the top of the first step. */
  lead?: ReactNode;
  finishLabel: string;
  busy: boolean;
  onFinish: () => Promise<unknown>;
  onClose: () => void;
}) {
  const summary = sessionSummaries(draft);
  const w = useWizard({
    open: true,
    mode: edit ? 'edit' : 'create',
    dirty,
    steps: SESSION_STEPS.filter((s) => !edit || s.id !== 'review').map((s) => ({
      ...s,
      summary: summary[s.id as keyof typeof summary],
    })),
    errors: sessionErrors(draft, blocked),
    hints: SESSION_HINTS,
    fieldStep: SESSION_FIELD_STEP,
    onFinish,
  });
  const set = (patch: Partial<SessionDraft>) => setDraft((d) => ({ ...d, ...patch }));
  return (
    <WizardDialog
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
      title={title}
      wizard={w}
      dirty={dirty}
      finishLabel={finishLabel}
      busy={busy}
      notice={notice}
    >
      {w.id === 'passes' ? lead : null}
      {w.id === 'review' ? (
        <SessionReview draft={draft} orgName={orgName} onEdit={w.go} />
      ) : blocked ? (
        <Callout tone="warning">{blocked}</Callout>
      ) : (
        <SessionFields step={w.id as SessionBodyId} draft={draft} set={set} errors={w.errors} />
      )}
    </WizardDialog>
  );
}

export function NewSessionDialog({
  onClose,
  onCreated,
  initial,
}: {
  onClose: () => void;
  onCreated: (id: string) => void;
  initial?: ScanningSession;
}) {
  const scope = useOrgScope();
  const mode = useMode();
  const [draftMode] = useState(() => initial?.mode ?? mode);
  const manageable = scope.memberships.filter(
    (membership) =>
      membership.revokedAt === null && membership.capabilities.includes('scanning:manage'),
  );
  const selectedScope =
    !scope.isLoading &&
    !scope.isError &&
    scope.membership?.orgId === scope.orgId &&
    scope.membership?.revokedAt === null &&
    scope.membership.capabilities.includes('scanning:manage')
      ? scope.orgId
      : undefined;
  const create = useCreateSession();
  const [draft, setDraft] = useState(() => {
    const base = initial
      ? {
          ...sessionDraft(initial),
          name: `${initial.name} copy`.slice(0, 80),
          // A list row carries no zones; a copy starts with none.
          zoneIds: initial.zoneIds ?? [],
        }
      : emptySessionDraft();
    // Keep the source rules until the initial membership request settles.
    if (scope.isLoading || scope.isError) return { ...base, orgId: '' };
    return withOrganization(base, selectedScope ?? '');
  });
  useSeededZone(initial ? undefined : draft.orgId || undefined, (from, to) =>
    setDraft((d) => (d.timeZone === from ? { ...d, timeZone: to } : d)),
  );
  const initialized = useRef(!scope.isLoading && !scope.isError);
  useEffect(() => {
    if (initialized.current || scope.isLoading || scope.isError) return;
    initialized.current = true;
    setDraft((current) =>
      initial && selectedScope === initial.orgId
        ? { ...current, orgId: selectedScope }
        : withOrganization(current, selectedScope ?? ''),
    );
  }, [initial, scope.isError, scope.isLoading, selectedScope]);
  const [chose, setChose] = useState(false);
  // A picker choice is not authority until the selected scope has caught up.
  const authorizedOrg = Boolean(
    draft.orgId &&
      draft.orgId === selectedScope &&
      manageable.some((membership) => membership.orgId === draft.orgId),
  );
  const allowed = authorizedOrg && mode === draftMode;
  const blocked = allowed
    ? undefined
    : authorizedOrg && mode !== draftMode
      ? `Switch to ${draftMode === 'test' ? 'Test' : 'Live'} mode to create this session.`
      : 'Choose an organization with scanning management access.';
  const picker =
    selectedScope && draft.orgId === selectedScope && !chose ? null : (
      <FormField label="Organization" required>
        {(props) => (
          <Select
            {...props}
            value={authorizedOrg ? draft.orgId : ''}
            options={manageable.map((membership) => ({
              value: membership.orgId,
              label: membership.orgName,
            }))}
            disabled={scope.isLoading || scope.isError}
            onValueChange={(orgId) => {
              if (!manageable.some((membership) => membership.orgId === orgId)) return;
              setChose(true);
              setDraft((current) => withOrganization(current, orgId));
              scope.setOrgId(orgId);
            }}
          />
        )}
      </FormField>
    );
  return (
    <SessionWizard
      title={initial ? 'Duplicate session' : 'New session'}
      edit={false}
      draft={draft}
      setDraft={setDraft}
      dirty={!!draft.name}
      blocked={blocked}
      orgName={manageable.find((m) => m.orgId === draft.orgId)?.orgName}
      lead={picker}
      finishLabel="Create session"
      busy={create.isPending}
      onFinish={async () => onCreated((await create.mutateAsync(sessionBody(draft))).id)}
      onClose={onClose}
    />
  );
}
export function SessionRulesDialog({
  session,
  onClose,
}: {
  session: ScanningSession;
  onClose: () => void;
}) {
  const scope = useOrgScope();
  const mode = useMode();
  const [draft, setDraft] = useState(() => sessionDraft(session));
  const [revision, setRevision] = useState(session.updatedAt);
  const save = useUpdateSession(session.id);
  const [conflict, setConflict] = useState(false);
  const changed = session.updatedAt !== revision || conflict;
  const dirty = JSON.stringify(draft) !== JSON.stringify(sessionDraft(session));
  const authorizedOrg = Boolean(
    !scope.isLoading &&
      !scope.isError &&
      scope.orgId === session.orgId &&
      draft.orgId === session.orgId &&
      scope.membership?.orgId === session.orgId &&
      scope.membership.revokedAt === null &&
      scope.membership.capabilities.includes('scanning:manage'),
  );
  const allowed = authorizedOrg && session.mode === mode;
  const blocked = allowed
    ? undefined
    : authorizedOrg && session.mode !== mode
      ? `Switch to ${session.mode === 'test' ? 'Test' : 'Live'} mode to edit this session.`
      : 'Select this session’s organization with scanning management access.';
  return (
    <SessionWizard
      title="Session rules"
      edit
      draft={draft}
      setDraft={setDraft}
      dirty={dirty}
      blocked={blocked}
      notice={
        changed ? (
          <Callout tone="warning">
            Session settings changed elsewhere.
            <Button
              variant="link"
              onClick={() => {
                setDraft(sessionDraft(session));
                setRevision(session.updatedAt);
                setConflict(false);
              }}
            >
              Reload settings
            </Button>
          </Callout>
        ) : null
      }
      finishLabel="Save"
      busy={save.isPending}
      onFinish={async () => {
        if (changed) throw new Error('Reload settings first.');
        const { orgId: _org, ...body } = sessionBody(draft);
        try {
          await save.mutateAsync({ ...body, revision });
        } catch (cause) {
          if (isApiError(cause) && cause.code === 'SCANNING_SESSION_CHANGED') setConflict(true);
          throw cause;
        }
        onClose();
      }}
      onClose={onClose}
    />
  );
}
