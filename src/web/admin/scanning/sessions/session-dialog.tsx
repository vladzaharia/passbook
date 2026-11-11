import { useEffect, useRef, useState } from 'react';
import type { ScanningSession } from '@/shared/contracts/scanning-sessions.ts';
import { errorMessage } from '@/web/lib/errors.ts';
import { useMode } from '@/web/lib/mode.ts';
import { useOrgScope } from '@/web/lib/org-filter.tsx';
import { Button, Callout, Dialog, DialogContent, FormField, Select } from '@/web/ui/index.ts';
import { useCreateSession, useUpdateSession } from './api.ts';
import {
  emptySessionDraft,
  type SessionDraft,
  sessionBody,
  sessionDraft,
  sessionReady,
} from './draft.ts';
import { SessionFields } from './session-fields.tsx';

function withOrganization(draft: SessionDraft, orgId: string): SessionDraft {
  if (draft.orgId === orgId) return draft;
  const { eventId: _eventId, ...checkIn } = draft.checkIn;
  return { ...draft, orgId, eventId: '', templateIds: [], checkIn };
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
      ? { ...sessionDraft(initial), name: `${initial.name} copy`.slice(0, 80) }
      : emptySessionDraft();
    // Keep the source rules until the initial membership request settles.
    if (scope.isLoading || scope.isError) return { ...base, orgId: '' };
    return withOrganization(base, selectedScope ?? '');
  });
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
  const [error, setError] = useState('');
  // A picker choice is not authority until the selected scope has caught up.
  const authorizedOrg = Boolean(
    draft.orgId &&
      draft.orgId === selectedScope &&
      manageable.some((membership) => membership.orgId === draft.orgId),
  );
  const allowed = authorizedOrg && mode === draftMode;
  async function submit() {
    if (!allowed || !sessionReady(draft)) return;
    setError('');
    try {
      const made = await create.mutateAsync(sessionBody(draft));
      onCreated(made.id);
    } catch (cause) {
      setError(errorMessage(cause));
    }
  }
  return (
    <Dialog open onOpenChange={(open) => !open && onClose()} dirty={!!draft.name}>
      <DialogContent
        title={initial ? 'Duplicate session' : 'New scanning session'}
        size="lg"
        footer={
          <>
            <Button variant="outline" onClick={onClose}>
              Cancel
            </Button>
            <Button
              loading={create.isPending}
              disabled={!allowed || !sessionReady(draft)}
              onClick={() => void submit()}
            >
              Create session
            </Button>
          </>
        }
      >
        {error ? <Callout tone="danger">{error}</Callout> : null}
        <FormField label="Organization" required className="mb-4">
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
                setDraft((current) => withOrganization(current, orgId));
                scope.setOrgId(orgId);
                setError('');
              }}
            />
          )}
        </FormField>
        {allowed ? (
          <SessionFields draft={draft} set={(patch) => setDraft((d) => ({ ...d, ...patch }))} />
        ) : (
          <Callout tone="warning">
            {authorizedOrg && mode !== draftMode
              ? `Switch to ${draftMode === 'test' ? 'Test' : 'Live'} mode to create this session.`
              : 'Choose an organization with scanning management access.'}
          </Callout>
        )}
      </DialogContent>
    </Dialog>
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
  const [error, setError] = useState('');
  const changed = session.updatedAt !== revision;
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
  async function submit() {
    if (!allowed || !sessionReady(draft) || changed || !dirty) return;
    setError('');
    try {
      const { orgId: _org, ...body } = sessionBody(draft);
      await save.mutateAsync({ ...body, revision });
      onClose();
    } catch (cause) {
      setError(errorMessage(cause));
    }
  }
  return (
    <Dialog open dirty={dirty} onOpenChange={(open) => !open && onClose()}>
      <DialogContent
        title="Session rules"
        size="lg"
        footer={
          <>
            <Button variant="outline" onClick={onClose}>
              Cancel
            </Button>
            <Button
              loading={save.isPending}
              disabled={!allowed || !sessionReady(draft) || changed || !dirty}
              onClick={() => void submit()}
            >
              Save session
            </Button>
          </>
        }
      >
        {changed || error ? (
          <Callout tone={changed ? 'warning' : 'danger'}>
            {changed ? 'Session settings changed elsewhere.' : error}
            <Button
              variant="link"
              onClick={() => {
                setDraft(sessionDraft(session));
                setRevision(session.updatedAt);
                setError('');
              }}
            >
              Reload settings
            </Button>
          </Callout>
        ) : null}
        {allowed ? (
          <SessionFields draft={draft} set={(patch) => setDraft((d) => ({ ...d, ...patch }))} />
        ) : (
          <Callout tone="warning">
            {authorizedOrg && session.mode !== mode
              ? `Switch to ${session.mode === 'test' ? 'Test' : 'Live'} mode to edit this session.`
              : 'Select this session’s organization with scanning management access.'}
          </Callout>
        )}
      </DialogContent>
    </Dialog>
  );
}
