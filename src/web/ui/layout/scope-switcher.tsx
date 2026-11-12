import { RefreshCw } from 'lucide-react';
import { useOrgScope } from '../../lib/org-filter.tsx';
import { Button } from '../button.tsx';
import { Combobox } from '../combobox.tsx';
import { EntityAvatar } from '../entity.tsx';

/** Select an authorized membership, including when the current page is unscoped or denied. */
export function ScopeSwitcher() {
  const { orgId, setOrgId, memberships, isLoading, isError, refetch } = useOrgScope();
  if (isLoading) {
    return (
      <span role="status" className="text-xs text-fg-muted max-sm:sr-only">
        Loading organizations…
      </span>
    );
  }
  if (isError) {
    return (
      <>
        <span role="alert" className="sr-only">
          Could not load organization access.
        </span>
        <Button
          variant="outline"
          size="sm"
          iconStart={<RefreshCw aria-hidden />}
          onClick={() => void refetch()}
        >
          <span className="max-sm:sr-only">Retry organizations</span>
        </Button>
      </>
    );
  }
  if (memberships.length === 0) return null;
  const options = memberships.map((membership) => ({
    value: membership.orgId,
    label: membership.orgName,
    icon: <EntityAvatar kind="org" id={membership.orgId} name={membership.orgName} />,
  }));
  return (
    <>
      <span id="org-filter-help" className="sr-only">
        Filters supported views; it does not change your access.
      </span>
      <Combobox
        aria-label="Organization filter"
        aria-describedby="org-filter-help"
        searchPlaceholder="Find an organization"
        placeholder="Choose an organization"
        className="w-auto min-w-0 max-w-48 gap-1.5 px-2.5"
        options={options}
        compact={Boolean(orgId)}
        value={orgId}
        onValueChange={setOrgId}
      />
    </>
  );
}
