import { passDetail, passSummary } from '../../admin/passes/test-fixtures.ts';
import { type FetchHandler, json } from '../../lib/test-utils.tsx';
import { handlers as shell } from '../shell/test-fixtures.ts';

export const ADA = passSummary({ id: 'p1', orgId: 'sbx', title: 'Ada Lovelace', version: 3 });
export const BOB = passSummary({
  id: 'p2',
  orgId: 'sbx',
  title: 'Bob Stone',
  status: 'voided',
  deviceCount: 0,
});

export interface Call {
  method: string;
  path: string;
  search: string;
  headers: Record<string, string>;
  body: unknown;
}

export interface World {
  passes: ReturnType<typeof passSummary>[];
  calls: Call[];
  /** Whether Void is answered (a voided pass reads voided after). */
  voided?: Set<string>;
}

/** The routes the Passes tool calls, each recorded. */
export function passesHandlers(world: World): Record<string, FetchHandler> {
  const at = (path: string, fn: FetchHandler): [string, FetchHandler] => [
    path,
    (url, init) => {
      world.calls.push({
        method: (init?.method ?? 'GET').toUpperCase(),
        path: url.pathname,
        search: url.search,
        headers: Object.fromEntries(new Headers(init?.headers).entries()),
        body: init?.body ? JSON.parse(String(init.body)) : undefined,
      });
      return fn(url, init);
    },
  ];
  const routes: [string, FetchHandler][] = [
    at('/api/v1/passes', () => json({ items: world.passes, nextCursor: null })),
    at('/api/v1/events', () =>
      json({
        items: [
          {
            id: 'ev1',
            type: 'pass.installed',
            createdAt: 1_700_000_000_000,
            requestId: 'req1',
            simulated: true,
          },
        ],
      }),
    ),
    at('/api/v1/request-logs', () =>
      json({
        items: [
          {
            id: 'log1',
            requestId: 'req1',
            at: 1_700_000_000_000,
            method: 'PATCH',
            route: '/api/v1/passes/:id',
            path: '/api/v1/passes/p1',
            query: null,
            status: 200,
            code: null,
            durationMs: 12,
            keyId: null,
            mode: 'test',
            via: 'try',
            client: null,
            hasBodies: true,
            resourceId: 'p1',
            apiVersion: null,
            flags: { idempotencyKey: false, ifMatch: false, version: false },
          },
        ],
        nextCursor: null,
        capped: null,
        bodiesRecorded: true,
      }),
    ),
  ];
  for (const p of world.passes) {
    const orgId = p.orgId as string;
    routes.push(
      at(`/api/v1/passes/${p.id}`, () =>
        json(
          passDetail({
            ...p,
            orgId,
            status: world.voided?.has(p.id as string) ? 'voided' : p.status,
            downloadUrl: `/p/${p.id}/pass.pkpass`,
          }),
        ),
      ),
      at(`/api/v1/passes/${p.id}/events`, () => json({ items: [], nextCursor: null })),
      at(`/api/v1/passes/${p.id}/devices`, () => json({ version: 3, devices: [], removal: null })),
      at(`/api/v1/passes/${p.id}/simulate`, () =>
        json({ eventId: 'ev1', requestId: 'req1', deviceId: 'dv1' }, 201),
      ),
      at(`/api/v1/passes/${p.id}/void`, () => {
        world.voided?.add(p.id as string);
        return json(passSummary({ ...p, status: 'voided' }));
      }),
    );
  }
  return { ...shell(), ...Object.fromEntries(routes) };
}
