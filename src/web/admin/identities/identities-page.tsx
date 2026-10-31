import { Link } from '@tanstack/react-router';
import { ShieldCheck, Upload } from 'lucide-react';
import { useState } from 'react';
import {
  Badge,
  Button,
  DataTable,
  EmptyState,
  ErrorState,
  PageHeader,
  SkeletonRows,
} from '@/web/ui/index.ts';
import { useOrgNames } from '../orgs/queries.ts';
import { ApnsPill, ExpiryPill } from './expiry.tsx';
import { useIdentities } from './queries.ts';
import { UploadIdentityDialog } from './upload-dialog.tsx';

export function IdentitiesPage() {
  const list = useIdentities();
  const orgName = useOrgNames();
  const [uploading, setUploading] = useState(false);
  const now = Date.now();
  return (
    <>
      <PageHeader
        title="Apple identities"
        actions={
          <Button iconStart={<Upload aria-hidden />} onClick={() => setUploading(true)}>
            Upload
          </Button>
        }
      />
      {list.isPending ? (
        <SkeletonRows label="Loading identities" />
      ) : list.isError ? (
        <ErrorState error={list.error} onRetry={() => list.refetch()} />
      ) : (
        <DataTable
          caption="Apple identities"
          data={list.data.items}
          getRowId={(i) => i.id}
          empty={
            <EmptyState
              icon={ShieldCheck}
              title="No identities"
              action={<Button onClick={() => setUploading(true)}>Upload</Button>}
            />
          }
          columns={[
            {
              header: 'Label',
              id: 'label',
              cell: ({ row }) => (
                <Link
                  to="/admin/identities/$identityId"
                  params={{ identityId: row.original.id }}
                  className="font-medium text-accent-fg hover:underline"
                >
                  {row.original.label}
                </Link>
              ),
            },
            {
              header: 'Pass type ID',
              id: 'ptid',
              cell: ({ row }) => (
                <span className="font-mono text-xs">
                  {row.original.passTypeIdentifier}
                  <span className="block text-fg-muted">{row.original.teamIdentifier}</span>
                </span>
              ),
            },
            { header: 'Owner', id: 'org', cell: ({ row }) => orgName(row.original.orgId) },
            {
              header: 'Certificate',
              id: 'expiry',
              cell: ({ row }) => <ExpiryPill identity={row.original} now={now} />,
            },
            { header: 'APNs', id: 'apns', cell: ({ row }) => <ApnsPill identity={row.original} /> },
            {
              header: 'Flags',
              id: 'flags',
              cell: ({ row }) => (
                <span className="flex flex-wrap gap-1">
                  {row.original.isDefault ? <Badge tone="accent">Default</Badge> : null}
                  {row.original.nfcEnabled ? <Badge>NFC</Badge> : null}
                  {row.original.source === 'env' ? <Badge>Env</Badge> : null}
                </span>
              ),
            },
          ]}
        />
      )}
      <UploadIdentityDialog open={uploading} onOpenChange={setUploading} />
    </>
  );
}
