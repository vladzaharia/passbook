import { Link } from '@tanstack/react-router';
import { useOrgScope } from '../../../lib/org-filter.tsx';
import { Button, Callout } from '../../../ui/index.ts';

/** After Save version: passes keep the active version until a release is approved. */
export function SavedCallout({
  templateId,
  canPublish,
}: {
  templateId: string;
  canPublish: boolean;
}) {
  const { orgId } = useOrgScope();
  return (
    <Callout
      className="dz-seal mb-4"
      tone="success"
      actions={
        <Button asChild variant="outline" size="sm">
          <Link
            to="/admin/templates/$templateId"
            params={{ templateId }}
            search={canPublish ? { tab: 'versions', orgId } : { orgId }}
          >
            {canPublish ? 'Review release' : 'Open template'}
          </Link>
        </Button>
      }
    >
      Version saved. Existing releases are unchanged.
    </Callout>
  );
}
