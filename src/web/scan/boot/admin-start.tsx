import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { OrgListSchema } from '../../../shared/contracts/orgs.ts';
import { Button } from '../../ui/button.tsx';
import { Select } from '../../ui/select.tsx';
import { BootCard } from '../ui/boot-card.tsx';

export function AdminStart({ onOrg }: { onOrg: (orgId: string) => void }) {
  const [org, setOrg] = useState('');
  const query = useQuery({
    queryKey: ['scan', 'admin-orgs'],
    queryFn: async () => {
      const response = await fetch('/api/v1/orgs?limit=100', {
        credentials: 'same-origin',
        headers: { accept: 'application/json' },
      });
      if (!response.ok) throw new Error('Organizations unavailable.');
      return OrgListSchema.parse(await response.json());
    },
  });
  return (
    <BootCard title="Scan as admin" line="Choose an organization.">
      {query.data ? (
        <>
          <Select
            aria-label="Organization"
            value={org}
            onValueChange={setOrg}
            options={query.data.items.map((o) => ({ value: o.id, label: o.name }))}
          />
          <Button disabled={!org} onClick={() => onOrg(org)}>
            Continue
          </Button>
        </>
      ) : (
        <p>{query.isError ? 'Could not load organizations.' : 'Loading…'}</p>
      )}
    </BootCard>
  );
}
