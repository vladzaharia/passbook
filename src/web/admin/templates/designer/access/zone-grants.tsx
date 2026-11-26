import { Plus, X } from 'lucide-react';
import { useState } from 'react';
import type { AccessGrant, AccessPlan, ValidationIssue } from '@/passkit/types.ts';
import { ZoneKeySchema } from '@/shared/contracts/scan-access.ts';
import { type ToolScope, useToolScope } from '../../../../lib/tool-api.tsx';
import { Button, Combobox, IconButton, Input, SwitchRow, WeekGrid } from '../../../../ui/index.ts';
import { usePinnedZones, useZones } from '../../../scanning/zones-query.ts';
import { useDesigner } from '../context.tsx';
import { PlaceLink } from '../host.tsx';
import { dayErrors } from './issues.ts';

const ALL = '*';
const isAll = (g: AccessGrant) => g.zone === ALL;
const keyOf = (g: AccessGrant): string | null => (typeof g.zone === 'string' ? g.zone : null);

type Props = { plan: AccessPlan; issues: readonly ValidationIssue[] };
type Zones = ReturnType<typeof useZones>;

function AdminZoneGrants(props: Props) {
  return <ZoneGrantsView {...props} zones={useZones()} />;
}

function PinnedZoneGrants({ scope, ...props }: Props & { scope: ToolScope }) {
  return <ZoneGrantsView {...props} zones={usePinnedZones(scope)} />;
}

/**
 * Who a plan lets in where: every zone, or the zones picked, each optionally with hours of its
 * own inside the plan's. Zones come from the host's pinned org and client, else admin's URL scope.
 */
export function ZoneGrants(props: Props) {
  const scope = useToolScope();
  return scope ? <PinnedZoneGrants {...props} scope={scope} /> : <AdminZoneGrants {...props} />;
}

function ZoneGrantsView({ plan, issues, zones }: Props & { zones: Zones }) {
  const { edit } = useDesigner();
  const [typed, setTyped] = useState('');
  const list = zones.data?.items ?? [];
  const known = new Set(list.map((z) => z.key));
  const set = (next: AccessGrant[], merge?: string) =>
    edit({ op: 'access-plan-set', id: plan.id, patch: { zones: next } }, merge);
  const every = plan.zones.some(isAll);
  const chosen = new Set(plan.zones.flatMap((g) => (keyOf(g) ? [keyOf(g) as string] : [])));
  const options = list
    .filter((z) => !chosen.has(z.key))
    .map((z) => ({ value: z.key, label: `${'\u00a0\u00a0'.repeat(z.depth)}${z.name}` }));
  const add = (key: string) => key && set([...plan.zones.filter((g) => !isAll(g)), { zone: key }]);
  const typedProblem = typed !== '' && !ZoneKeySchema.safeParse(typed).success;
  return (
    <div className="grid gap-3">
      <SwitchRow
        label="All zones"
        help="Every zone of the organization, now and later."
        checked={every}
        onCheckedChange={(on) => set(on ? [{ zone: ALL }] : [])}
      />
      {every ? null : (
        <>
          <ul aria-label={`${plan.label} zones`} className="grid gap-2">
            {plan.zones.map((grant, at) => {
              const key = keyOf(grant);
              const which = key ?? `input:${(grant.zone as { input: string }).input}`;
              // A grant has no id: its zone and which of equal ones it is.
              const nth = plan.zones
                .slice(0, at)
                .filter(
                  (g) =>
                    (keyOf(g) ?? JSON.stringify(g.zone)) === (key ?? JSON.stringify(grant.zone)),
                ).length;
              const name = key ? (list.find((z) => z.key === key)?.name ?? key) : null;
              const limited = grant.hours !== undefined;
              return (
                <li
                  key={`${which}#${nth}`}
                  className="ac-grant grid gap-2 rounded-md border border-border p-2"
                >
                  <div className="flex items-center gap-2">
                    <div className="min-w-0 flex-1">
                      <p className="truncate text-sm font-medium text-fg-strong">
                        {name ?? `Zone from the ${(grant.zone as { input: string }).input} input`}
                      </p>
                      {key && name !== key ? (
                        <p className="truncate font-mono text-xs text-fg-muted">{key}</p>
                      ) : null}
                    </div>
                    <IconButton
                      label={`Remove ${name ?? 'zone'}`}
                      icon={<X aria-hidden />}
                      size="sm"
                      onClick={() => set(plan.zones.filter((_, n) => n !== at))}
                    />
                  </div>
                  {key && zones.isSuccess && !known.has(key) ? (
                    <p className="text-xs text-warning">
                      {key} isn&apos;t a zone yet.{' '}
                      <PlaceLink place={{ to: 'zones' }} className="underline">
                        Create zone
                      </PlaceLink>
                    </p>
                  ) : null}
                  <SwitchRow
                    label="Limit hours"
                    checked={limited}
                    onCheckedChange={(on) =>
                      set(
                        plan.zones.map((g, n) => {
                          if (n !== at) return g;
                          const { hours: _h, ...rest } = g;
                          return on
                            ? { ...rest, hours: plan.hours ?? { mon: ['09:00-17:00'] } }
                            : rest;
                        }),
                      )
                    }
                  />
                  {limited ? (
                    <WeekGrid
                      label={`${name ?? 'Zone'} in ${plan.label}`}
                      hours={grant.hours}
                      within={plan.hours}
                      mergeKey={`${plan.id}:z${at}`}
                      errors={dayErrors(issues, at)}
                      onChange={(hours, merge) =>
                        set(
                          plan.zones.map((g, n) => {
                            if (n !== at) return g;
                            const { hours: _h, ...rest } = g;
                            return hours ? { ...rest, hours } : { ...rest, hours: {} };
                          }),
                          merge,
                        )
                      }
                    />
                  ) : null}
                </li>
              );
            })}
          </ul>
          {plan.zones.length === 0 ? (
            <p className="text-sm text-fg-muted">No zones. Pick at least one.</p>
          ) : null}
          {zones.isSuccess ? (
            <Combobox
              aria-label={`Add a zone to ${plan.label}`}
              placeholder="Add a zone"
              searchPlaceholder="Find a zone"
              emptyText="No more zones"
              options={options}
              value={undefined}
              onValueChange={add}
            />
          ) : (
            <form
              className="flex flex-wrap items-start gap-2"
              onSubmit={(e) => {
                e.preventDefault();
                if (typed && !typedProblem) {
                  add(typed);
                  setTyped('');
                }
              }}
            >
              <Input
                aria-label="Zone key"
                aria-invalid={typedProblem || undefined}
                className="min-w-0 flex-1"
                placeholder="pool"
                value={typed}
                onChange={(e) => setTyped(e.target.value)}
              />
              <Button
                type="submit"
                variant="outline"
                iconStart={<Plus aria-hidden />}
                disabled={typed === '' || typedProblem}
              >
                Add zone
              </Button>
              {typedProblem ? (
                <p role="alert" className="basis-full text-xs text-danger">
                  Use a-z, 0-9 and -.
                </p>
              ) : null}
            </form>
          )}
        </>
      )}
    </div>
  );
}
