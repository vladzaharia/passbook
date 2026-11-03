import { Link } from '@tanstack/react-router';
import { ChevronRight } from 'lucide-react';
import { useEffect, useState } from 'react';
import type { z } from 'zod';
import type { OrgSummarySchema } from '@/shared/contracts/orgs.ts';
import { ENTITY, type EntityKind } from '@/web/lib/entities.ts';
import { formatCount, formatDateTime } from '@/web/lib/format.ts';
import {
  Button,
  Card,
  CardBody,
  CardHeader,
  Checklist,
  CountUp,
  KeyValue,
} from '@/web/ui/index.ts';

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
export function CountsCard({ org }: { org: Org }) {
  const animate = useFirstArrival(org.id);
  return (
    <Card>
      <CardHeader title="In this organization" />
      <CardBody>
        <ul className="grid grid-cols-2 gap-2">
          {TILES.map(({ kind, key, to }) => {
            const { icon: Icon, label, plural } = ENTITY[kind];
            const n = org.counts[key];
            const noun = n === 1 ? label.toLowerCase() : plural;
            const text = kind === 'apiKey' ? (n === 1 ? 'API key' : 'API keys') : noun;
            return (
              <li key={key}>
                <Link
                  to={to}
                  search={{ orgId: org.id }}
                  aria-label={`${n} ${text} in ${org.name}`}
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
                    {org.countsCapped && n >= 100_000 ? '+' : ''}
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
            { label: 'ID', value: org.id, mono: true },
          ]}
        />
      </CardBody>
    </Card>
  );
}

/** Next steps for an org without passes; each step checks itself from the counts. */
export function OrgChecklist({ org }: { org: Org }) {
  const go = (to: string, label: string, scoped = true) => (
    <Button asChild variant="ghost" size="sm" iconEnd={<ChevronRight aria-hidden />}>
      <Link to={to} search={scoped ? { orgId: org.id } : {}}>
        {label}
      </Link>
    </Button>
  );
  return (
    <Card>
      <CardBody>
        <Checklist
          title="Get started"
          steps={[
            {
              id: 'template',
              label: 'Assign a template',
              done: org.counts.templates > 0,
              action: go('/admin/templates', 'Templates', false),
            },
            {
              id: 'pass',
              label: 'Issue a pass',
              done: org.counts.passes > 0,
              action: go('/admin/passes/new', 'New pass'),
            },
            {
              id: 'source',
              label: 'Connect a source',
              done: org.counts.connections > 0,
              action: go('/admin/connections/new', 'New connection'),
            },
          ]}
        />
      </CardBody>
    </Card>
  );
}
