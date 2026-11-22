import { Link } from '@tanstack/react-router';
import { Megaphone, PencilLine } from 'lucide-react';
import { useOrgScope } from '../../../lib/org-filter.tsx';
import { Button } from '../../../ui/index.ts';
import { CHANGE_COPY as C } from './copy.ts';
import { canChangePasses } from './selection.ts';

/** Whether the person may run a change: operate passes and manage messages in this organization. */
export function useCanChange(): boolean {
  return canChangePasses(useOrgScope().membership?.capabilities);
}

/** On an import's results: change the passes the import touched. */
export function ChangeTheseLink({ orgId, importId }: { orgId: string; importId: string }) {
  if (!useCanChange()) return null;
  return (
    <Button asChild variant="outline" iconStart={<PencilLine aria-hidden />}>
      <Link to="/admin/o/$orgId/passes/change" params={{ orgId }} search={{ importId }}>
        {C.entry.changeThese}
      </Link>
    </Button>
  );
}

/** On a template whose passes are on an older design: tell holders as they move to the latest. */
export function TellHoldersLink({ orgId, templateId }: { orgId: string; templateId: string }) {
  if (!useCanChange()) return null;
  return (
    <Button asChild size="sm" variant="outline" iconStart={<Megaphone aria-hidden />}>
      <Link
        to="/admin/o/$orgId/passes/change"
        params={{ orgId }}
        search={{ templateId, kind: 'design', tell: true }}
      >
        {C.entry.tellHolders}
      </Link>
    </Button>
  );
}
