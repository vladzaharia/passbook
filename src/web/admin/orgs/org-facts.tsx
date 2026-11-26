import { Link } from '@tanstack/react-router';
import type { z } from 'zod';
import type { OrgSummarySchema } from '@/shared/contracts/orgs.ts';
import { formatDateTime, formatDay } from '@/web/lib/format.ts';
import { Card, CardBody, CardHeader, KeyValue, TechnicalDetails } from '@/web/ui/index.ts';
import { useOrgIdentities } from '../wallet-accounts/apple/queries.ts';

/** Read-only facts: when it was created and what signs its passes; the id sits under Technical details. */
export function OrgFacts({ org }: { org: z.infer<typeof OrgSummarySchema> }) {
  const identity = useOrgIdentities(org.id).data?.items[0];
  const signing = identity ? `${identity.label}, expires ${formatDay(identity.notAfter)}` : null;
  return (
    <Card>
      <CardHeader title="Organization" />
      <CardBody>
        <KeyValue
          items={[
            { label: 'Created', value: formatDateTime(org.createdAt) },
            {
              label: 'Signing',
              value: (
                <Link
                  to="/admin/o/$orgId/brand"
                  hash="channels"
                  params={{ orgId: org.id }}
                  className="text-accent-fg hover:underline"
                >
                  {signing ?? 'Shared with PassBook'}
                </Link>
              ),
            },
          ]}
        />
        <TechnicalDetails className="mt-3" items={[{ label: 'ID', value: org.id, copy: true }]} />
      </CardBody>
    </Card>
  );
}
