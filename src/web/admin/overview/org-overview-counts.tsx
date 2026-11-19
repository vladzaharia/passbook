import { Link } from '@tanstack/react-router';
import { ENTITY, type EntityKind } from '@/web/lib/entities.ts';
import { formatCount } from '@/web/lib/format.ts';
import { Card, CardBody } from '@/web/ui/index.ts';
import { useOrgWorkspace } from '../orgs/queries.ts';

const TILES = [
  { kind: 'template', key: 'templates', to: '/admin/o/$orgId/templates', cap: 'templates:read' },
  {
    kind: 'connection',
    key: 'connections',
    to: '/admin/o/$orgId/connections',
    cap: 'integrations:read',
  },
  { kind: 'apiKey', key: 'apiKeys', to: '/admin/o/$orgId/api-keys', cap: 'integrations:read' },
] as const satisfies readonly {
  kind: EntityKind;
  key: 'templates' | 'connections' | 'apiKeys';
  to: string;
  cap: string;
}[];

/** What the organization holds besides passes: each count opens its list. */
export function OrgCounts({ orgId, caps }: { orgId: string; caps: readonly string[] }) {
  const counts = useOrgWorkspace(orgId).data?.counts;
  const tiles = TILES.filter((t) => caps.includes(t.cap));
  if (!counts || tiles.length === 0) return null;
  return (
    <Card>
      <CardBody>
        <ul className="grid grid-cols-1 gap-2 sm:grid-cols-3">
          {tiles.map(({ kind, key, to }) => {
            const { icon: Icon, label, plural } = ENTITY[kind];
            const n = counts[key];
            const text =
              kind === 'apiKey'
                ? n === 1
                  ? 'API key'
                  : 'API keys'
                : n === 1
                  ? label.toLowerCase()
                  : plural;
            return (
              <li key={key}>
                <Link
                  to={to}
                  params={{ orgId }}
                  className="flex items-center gap-3 rounded-md border border-border p-3 wl-colors hover:border-border-strong hover:bg-state-hover-tint focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus"
                >
                  <Icon aria-hidden className="size-4 text-fg-muted" />
                  <span className="text-xl font-semibold text-fg-strong tabular-nums">
                    {formatCount(n)}
                  </span>
                  <span className="text-sm text-fg-muted first-letter:uppercase">{text}</span>
                </Link>
              </li>
            );
          })}
        </ul>
      </CardBody>
    </Card>
  );
}
