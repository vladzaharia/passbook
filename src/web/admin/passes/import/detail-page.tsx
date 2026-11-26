import { Link, useNavigate } from '@tanstack/react-router';
import { useEffect, useState } from 'react';
import { IMPORT_COPY as C } from '@/shared/copy/imports.ts';
import { OrgChooser } from '@/web/ui/layout/org-chooser.tsx';
import { useOrgScope } from '../../../lib/org-filter.tsx';
import { orgPath } from '../../../lib/scope.ts';
import {
  Badge,
  Button,
  Card,
  CardBody,
  EmptyState,
  ErrorState,
  PageHeader,
  Skeleton,
  Stepper,
} from '../../../ui/index.ts';
import {
  type LocalOperationDef,
  OperationProgress,
  useLocalOperation,
} from '../../../ui/operation/index.ts';
import { useOrgTimeZone } from '../../settings/use-org-time-zone.ts';
import { useImport } from './api.ts';
import { CheckStep } from './check-step.tsx';
import { takeFresh } from './fresh.ts';
import { MatchStep } from './match-step.tsx';
import { ImportResults } from './results.tsx';
import { stateBadge } from './state-tone.ts';
import { IMPORT_STEPS, STEP } from './steps.ts';

const CHECK_DEF: LocalOperationDef = {
  kind: 'import.check',
  title: 'Check import',
  steps: [{ key: 'check', label: 'Check rows', active: C.match.checking }],
};

/** The check is one request with no status of its own: one running step until the state moves on. */
function Checking({ onStep, orgId }: { onStep: (step: number) => void; orgId: string }) {
  const { operation, driver } = useLocalOperation(CHECK_DEF, useOrgTimeZone(orgId));
  useEffect(() => driver.step('check'), [driver]);
  return (
    <div className="flex flex-col gap-6">
      <Stepper steps={IMPORT_STEPS} current={STEP.check} onStep={onStep} />
      <Card>
        <CardBody>
          <OperationProgress operation={operation} />
        </CardBody>
      </Card>
    </div>
  );
}

/** One import, by state: match, check, run and results, under one stepper. */
export function ImportDetailPage({ importId }: { importId: string }) {
  const navigate = useNavigate();
  const { orgId, membership } = useOrgScope();
  const query = useImport(importId, orgId);
  const [editing, setEditing] = useState(() => takeFresh(importId));
  const imp = query.data;
  const canSync = membership?.capabilities.includes('integrations:manage') ?? false;
  const canOperate = membership?.capabilities.includes('passes:operate') ?? false;
  const source = () => orgId && void navigate({ href: orgPath(orgId, '/passes/import') });
  const goto = (step: number) => {
    if (step === STEP.source) source();
    else setEditing(step === STEP.match);
  };

  if (!orgId) return <OrgChooser title={C.chooseOrg} />;
  let body = <Skeleton className="h-64" />;
  if (query.isError)
    body = <ErrorState subject="the import" error={query.error} onRetry={() => query.refetch()} />;
  else if (imp) {
    if (imp.state === 'expired' || imp.state === 'discarded')
      body = (
        <EmptyState
          art="torn"
          title={C.results.gone}
          action={
            <Button asChild variant="outline">
              <Link to={orgPath(orgId, '/passes/import')}>{C.results.startAgain}</Link>
            </Button>
          }
        />
      );
    else if (imp.state === 'checking') body = <Checking onStep={goto} orgId={orgId} />;
    else if (
      imp.state === 'committing' ||
      ((imp.state === 'done' || imp.state === 'failed') && imp.progress)
    )
      body = (
        <ImportResults
          imp={imp}
          orgId={orgId}
          canSync={canSync}
          canOperate={canOperate}
          onSource={source}
        />
      );
    else if ((imp.state === 'ready' || imp.state === 'stale') && !editing)
      body = (
        <CheckStep
          imp={imp}
          orgId={orgId}
          canOperate={canOperate}
          onStep={goto}
          onDiscarded={source}
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
          onStep={goto}
        />
      );
  }

  return (
    <>
      <PageHeader
        title={imp?.source.name ?? 'Import'}
        breadcrumbs={[
          { label: 'Passes', to: orgId ? orgPath(orgId, '/passes') : '/admin/passes' },
          {
            label: 'Import',
            to: orgId ? orgPath(orgId, '/passes/import') : '/admin/passes/import',
          },
          { label: imp?.source.name ?? 'Import' },
        ]}
        meta={imp ? <Badge tone={stateBadge(imp).tone}>{stateBadge(imp).label}</Badge> : undefined}
      />
      {body}
    </>
  );
}
