import { useQuery } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { ChevronRight } from 'lucide-react';
import { useEffect, useState } from 'react';
import type { z } from 'zod';
import { MetricsOverviewSchema } from '@/shared/contracts/metrics.ts';
import type { OrgSummarySchema } from '@/shared/contracts/orgs.ts';
import { api } from '@/web/lib/api.ts';
import { ENTITY, type EntityKind } from '@/web/lib/entities.ts';
import { formatCount, formatDateTime } from '@/web/lib/format.ts';
import { useMode } from '@/web/lib/mode.ts';
import {
  Button,
  Card,
  CardBody,
  CardHeader,
  Checklist,
  CountUp,
  ErrorState,
  KeyValue,
  TechnicalDetails,
} from '@/web/ui/index.ts';
import { ApnsPill, ExpiryPill } from '../identities/expiry.tsx';
import { useIdentityOptions } from '../identities/queries.ts';
import { checklistSteps, setupDone } from '../overview/get-started.tsx';

type Org = z.infer<typeof OrgSummarySchema>;

/** Orgs whose counts already counted up this session: later visits show the number at once. */
const counted = new Set<string>();

function useFirstArrival(id: string): boolean {
  const [first] = useState(() => !counted.has(id));
  useEffect(() => {
    counted.add(id);
  }, [id]);
  return first;
}

const TILES: { kind: EntityKind; key: keyof Org['counts']; to: string }[] = [
  { kind: 'pass', key: 'passes', to: '/admin/passes' },
  { kind: 'template', key: 'templates', to: '/admin/templates' },
  { kind: 'connection', key: 'connections', to: '/admin/connections' },
  { kind: 'apiKey', key: 'apiKeys', to: '/admin/api-keys' },
];

/** Count tiles that open each list scoped to the org (the top-bar scope, `?orgId=`). */
export function CountsCard({ org, showApiKeys }: { org: Org; showApiKeys: boolean }) {
  const animate = useFirstArrival(org.id);
  const mode = useMode();
  return (
    <Card>
      <CardHeader title="In this organization" />
      <CardBody>
        <p className="mb-3 text-xs text-fg-muted">
          Passes: {mode === 'test' ? 'Test' : 'Live'} mode. Other counts are not mode-filtered.
        </p>
        <ul className="grid grid-cols-2 gap-2">
          {TILES.map(({ kind, key, to }) => {
            if (kind === 'apiKey' && !showApiKeys) return null;
            const { icon: Icon, label, plural } = ENTITY[kind];
            const n = org.counts[key];
            const capped = org.countsCapped && n >= 100_000;
            const noun = n === 1 ? label.toLowerCase() : plural;
            const text = kind === 'apiKey' ? (n === 1 ? 'API key' : 'API keys') : noun;
            return (
              <li key={key}>
                <Link
                  to={to}
                  search={{ orgId: org.id }}
                  aria-label={`${capped ? 'At least ' : ''}${formatCount(n)} ${text} in ${org.name}`}
                  className="group flex min-h-20 flex-col gap-1 rounded-md border border-border p-3 wl-colors hover:border-border-strong hover:bg-state-hover-tint focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus"
                >
                  <span className="flex items-center justify-between text-fg-muted">
                    <Icon aria-hidden className="size-4" />
                    <ChevronRight
                      aria-hidden
                      className="size-4 transition-transform duration-(--wl-dur-hover) group-hover:translate-x-0.5 motion-reduce:transition-none"
                    />
                  </span>
                  <span className="text-2xl font-semibold text-fg-strong tabular-nums">
                    {animate ? <CountUp value={n} /> : formatCount(n)}
                    {capped ? '+' : ''}
                  </span>
                  <span className="text-xs text-fg-muted first-letter:uppercase">{text}</span>
                </Link>
              </li>
            );
          })}
        </ul>
      </CardBody>
    </Card>
  );
}

export function OverviewCard({ org }: { org: Org }) {
  return (
    <Card>
      <CardHeader title="Overview" />
      <CardBody>
        <KeyValue
          items={[
            { label: 'Slug', value: org.slug, mono: true },
            { label: 'Created', value: formatDateTime(org.createdAt) },
            { label: 'Updated', value: formatDateTime(org.updatedAt) },
          ]}
        />
        <TechnicalDetails className="mt-3" items={[{ label: 'ID', value: org.id }]} />
      </CardBody>
    </Card>
  );
}

/** The saved default and its actual certificate and APNs facts. */
export function SigningCard({ org }: { org: Org }) {
  const identities = useIdentityOptions();
  const items = identities.data?.items ?? [];
  const platform = items.find((identity) => identity.id === 'platform');
  const defaultIdentity = items.find((identity) => identity.isDefault);
  let identity: (typeof items)[number] | undefined;
  if (org.defaultIdentityId) {
    identity = items.find((item) => item.id === org.defaultIdentityId);
  } else if (defaultIdentity?.orgId === null || defaultIdentity?.orgId === org.id) {
    identity = defaultIdentity;
  } else if (defaultIdentity || (identities.data && !identities.data.nextCursor)) {
    // The configured global default is not usable here, or there is no configured default.
    identity = platform;
  }

  return (
    <Card>
      <CardHeader
        title="Apple signing identity"
        actions={
          <Button asChild variant="ghost" size="sm" iconEnd={<ChevronRight aria-hidden />}>
            <Link to="/admin/identities">Manage identities</Link>
          </Button>
        }
      />
      <CardBody className="flex flex-col gap-4">
        <p className="text-sm text-fg-muted">
          The saved default applies to new passes. Existing passes keep their signer.
        </p>
        {identities.isPending ? (
          <p role="status" className="text-sm text-fg-muted">
            Loading signing identity…
          </p>
        ) : identities.isError ? (
          <ErrorState
            subject="signing identities"
            error={identities.error}
            onRetry={() => identities.refetch()}
          />
        ) : identity ? (
          <KeyValue
            items={[
              {
                label: org.defaultIdentityId ? 'Organization default' : 'Fallback default',
                value: (
                  <Link
                    to="/admin/identities/$identityId"
                    params={{ identityId: identity.id }}
                    className="text-accent-fg hover:underline"
                  >
                    {identity.label}
                  </Link>
                ),
              },
              {
                label: 'Certificate expiry',
                value: <ExpiryPill identity={identity} now={Date.now()} />,
              },
              { label: 'Apple push', value: <ApnsPill identity={identity} /> },
              {
                label: 'Push last checked',
                value: formatDateTime(identity.apnsCheckedAt, 'Not checked'),
              },
            ]}
          />
        ) : (
          <p className="text-sm text-fg-muted">
            The saved signing identity could not be determined from the available records.
            {identities.data?.nextCursor ? ' Only the first 200 identities were loaded.' : ''}
          </p>
        )}
      </CardBody>
    </Card>
  );
}

/** The first-run path for an org until a pass is in a Wallet; each step checks itself from counts. */
export function OrgChecklist({ org }: { org: Org }) {
  const mode = useMode();
  const setup = useQuery({
    queryKey: ['metrics', 'org-setup', org.id, mode],
    queryFn: ({ signal }) =>
      api.get('/api/v1/metrics/overview', MetricsOverviewSchema, {
        query: { range: '24h', orgId: org.id },
        signal,
      }),
    staleTime: 0,
  });
  if (!setup.data || setupDone(setup.data.setup)) return null;
  return (
    <Card>
      <CardBody>
        <Checklist title="Get started" steps={checklistSteps(setup.data.setup, org.id)} />
      </CardBody>
    </Card>
  );
}
