import { Link, useNavigate } from '@tanstack/react-router';
import { useState } from 'react';
import { IMPORT_COPY as C } from '@/shared/copy/imports.ts';
import { useOrgScope } from '../../../lib/org-filter.tsx';
import { orgPath } from '../../../lib/scope.ts';
import {
  Badge,
  Buddy,
  Button,
  Card,
  CardBody,
  CardHeader,
  EmptyState,
  ErrorState,
  PageHeader,
  Skeleton,
} from '../../../ui/index.ts';
import { useImport } from './api.ts';
import { CheckStep } from './check-step.tsx';
import { MatchStep } from './match-step.tsx';
import { ImportProgress } from './progress.tsx';
import { ImportResults } from './results.tsx';
import { STATE_LABEL, STATE_TONE } from './state-tone.ts';

function Checking() {
  return (
    <Card>
      <CardHeader title={C.match.checking} />
      <CardBody className="flex items-center gap-4">
        <Buddy scene="inspect" size="sm" className="shrink-0" />
        <p role="status" className="text-sm text-fg-muted">
          {C.match.checking}
        </p>
      </CardBody>
    </Card>
  );
}

/** One import, by state: columns, check, progress, results. */
export function ImportDetailPage({ importId }: { importId: string }) {
  const navigate = useNavigate();
  const { orgId, membership } = useOrgScope();
  const query = useImport(importId, orgId);
  const [editing, setEditing] = useState(false);
  const imp = query.data;
  const canSync = membership?.capabilities.includes('integrations:manage') ?? false;
  const canOperate = membership?.capabilities.includes('passes:operate') ?? false;
  const back = () => orgId && void navigate({ href: orgPath(orgId, '/passes/import') });

  let body = <Skeleton className="h-64" />;
  if (!orgId) body = <EmptyState art="people" title={C.chooseOrg} />;
  else if (query.isError)
    body = <ErrorState subject="the import" error={query.error} onRetry={() => query.refetch()} />;
  else if (imp) {
    if (imp.state === 'expired' || imp.state === 'discarded')
      body = (
        <EmptyState
          art="torn"
          title={C.results.gone}
          action={
            <Button asChild variant="outline">
              <Link to={orgPath(orgId, '/passes/import')}>
                {C.results.startAgain}
              </Link>
            </Button>
          }
        />
      );
    else if (imp.state === 'checking') body = <Checking />;
    else if (imp.state === 'committing') body = <ImportProgress imp={imp} />;
    else if ((imp.state === 'done' || imp.state === 'failed') && imp.progress)
      body = <ImportResults imp={imp} orgId={orgId} canSync={canSync} canOperate={canOperate} />;
    else if ((imp.state === 'ready' || imp.state === 'stale') && !editing)
      body = (
        <CheckStep
          imp={imp}
          orgId={orgId}
          canOperate={canOperate}
          onEditColumns={() => setEditing(true)}
          onDiscarded={back}
        />
      );
    else if (!canOperate) body = <EmptyState art="lock" title={C.forbidden} />;
    else
      body = (
        <MatchStep
          key={editing ? 'edit' : imp.state}
          imp={imp}
          orgId={orgId}
          onChecked={() => setEditing(false)}
        />
      );
  }

  return (
    <>
      <PageHeader
        title={imp?.source.name ?? 'Import'}
        breadcrumbs={[
          { label: 'Passes', to: orgId ? orgPath(orgId, '/passes') : '/admin/passes' },
          { label: 'Import', to: orgId ? orgPath(orgId, '/passes/import') : '/admin/passes/import' },
          { label: imp?.source.name ?? 'Import' },
        ]}
        meta={
          imp ? <Badge tone={STATE_TONE[imp.state]}>{STATE_LABEL[imp.state]}</Badge> : undefined
        }
      />
      {body}
    </>
  );
}
