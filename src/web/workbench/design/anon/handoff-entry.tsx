import { useRouter } from '@tanstack/react-router';
import { useEffect, useState } from 'react';
import { WB_DESIGN } from '@/shared/copy/workbench-design.ts';
import { hasDeveloperAccess } from '@/shared/spaces.ts';
import { wbPath } from '@/shared/workbench.ts';
import { useSession } from '../../../lib/session.ts';
import { Skeleton } from '../../../ui/skeleton.tsx';
import { loadSession, type Session } from '../../console/session.ts';
import { useWorkbenchContexts } from '../../host/contexts.ts';
import { MakeSandbox } from '../../quickstart/make-sandbox.tsx';
import { ToolPage } from '../../shell/tool-page.tsx';
import { NoWorkbenchAccess, ToolFailed } from '../../states/states.tsx';
import '../../styles/legacy.css';
import '../../styles/legacy-kit.css';
import '../../quickstart/quickstart.css';

/** No sandbox yet: the create runs here, with its steps, and the hand-off goes on when it ends. */
function MakeHere({ onMade }: { onMade: () => void }) {
  const [session, setSession] = useState<Session | null>(null);
  const [op, setOp] = useState<string | null>(null);
  useEffect(() => {
    void loadSession().then(setSession);
  }, []);
  if (!session) return <Skeleton className="h-11 w-60" />;
  if (session.kind === 'out' || session.kind === 'failed') return <NoWorkbenchAccess />;
  return (
    <div className="wb-legacy grid max-w-md gap-3">
      <p className="text-sm text-fg-muted">{WB_DESIGN.anon.needSandbox}</p>
      <MakeSandbox
        csrf={session.csrf}
        siteKey={session.kind === 'none' || session.kind === 'closed' ? session.siteKey : ''}
        label={WB_DESIGN.anon.makeSandbox}
        onMade={onMade}
        op={op}
        onOp={setOp}
        autoFocus
      />
    </div>
  );
}

/**
 * `/workbench/design#…&s=1` signed in (design §1.9): to the sandbox's own Design with the hash
 * kept, where the save runs on the Workbench token. Without a sandbox it is made first, in place.
 */
function Body() {
  const { authed } = useSession();
  const contexts = useWorkbenchContexts();
  const router = useRouter();
  const sandbox = contexts.data?.find((c) => c.kind === 'sandbox');
  const orgId = sandbox?.orgId;
  useEffect(() => {
    if (orgId) router.history.replace(`${wbPath(orgId, 'design')}${location.hash}`);
  }, [orgId, router]);
  if (authed?.amr !== 'oidc') return <NoWorkbenchAccess />;
  if (contexts.isError)
    return <ToolFailed error={contexts.error} onRetry={() => contexts.refetch()} />;
  if (!contexts.data || sandbox)
    return <Skeleton role="status" aria-busy className="h-11 w-full max-w-md" />;
  if (!authed || !hasDeveloperAccess(authed.roles)) return <NoWorkbenchAccess />;
  return <MakeHere onMade={() => void contexts.refetch()} />;
}

export default function HandoffEntry() {
  return (
    <ToolPage tool="design">
      <Body />
    </ToolPage>
  );
}
