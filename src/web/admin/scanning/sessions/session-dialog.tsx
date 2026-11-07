import { useState } from 'react';
import type { ScanningSession } from '@/shared/contracts/scanning-sessions.ts';
import { errorMessage } from '@/web/lib/errors.ts';
import { useOrgScope } from '@/web/lib/org-filter.tsx';
import { Button, Callout, Dialog, DialogContent } from '@/web/ui/index.ts';
import { useOrgList } from '../../orgs/queries.ts';
import { useCreateSession, useUpdateSession } from './api.ts';
import { emptySessionDraft, sessionBody, sessionDraft, sessionReady } from './draft.ts';
import { SessionFields } from './session-fields.tsx';

export function NewSessionDialog({
  onClose,
  onCreated,
  initial,
}: {
  onClose: () => void;
  onCreated: (id: string) => void;
  initial?: ScanningSession;
}) {
  const { orgId } = useOrgScope();
  const orgs = useOrgList();
  const create = useCreateSession();
  const [draft, setDraft] = useState(() =>
    initial
      ? { ...sessionDraft(initial), name: `${initial.name} copy`.slice(0, 80) }
      : { ...emptySessionDraft(), orgId: orgId ?? '' },
  );
  const [error, setError] = useState('');
  const effective = {
    ...draft,
    orgId:
      draft.orgId || orgId || (orgs.data?.items.length === 1 ? (orgs.data.items[0]?.id ?? '') : ''),
  };
  async function submit() {
    setError('');
    try {
      const made = await create.mutateAsync(sessionBody(effective));
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
        description="Devices in a session share accepted passes, admission rules and staff access."
        footer={
          <>
            <Button variant="outline" onClick={onClose}>
              Cancel
            </Button>
            <Button
              loading={create.isPending}
              disabled={!sessionReady(effective)}
              onClick={() => void submit()}
            >
              Create session
            </Button>
          </>
        }
      >
        {error ? <Callout tone="danger">{error}</Callout> : null}
        <SessionFields
          draft={effective}
          set={(patch) => setDraft((d) => ({ ...d, ...patch }))}
          orgs={!orgId ? orgs.data?.items : undefined}
        />
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
  const [draft, setDraft] = useState(() => sessionDraft(session));
  const [revision, setRevision] = useState(session.updatedAt);
  const save = useUpdateSession(session.id);
  const [error, setError] = useState('');
  const changed = session.updatedAt !== revision;
  const dirty = JSON.stringify(draft) !== JSON.stringify(sessionDraft(session));
  async function submit() {
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
        description="Passes, admission and staff access are shared. Device defaults can be overridden."
        footer={
          <>
            <Button variant="outline" onClick={onClose}>
              Cancel
            </Button>
            <Button
              loading={save.isPending}
              disabled={!sessionReady(draft) || changed || !dirty}
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
        <SessionFields draft={draft} set={(patch) => setDraft((d) => ({ ...d, ...patch }))} />
      </DialogContent>
    </Dialog>
  );
}
