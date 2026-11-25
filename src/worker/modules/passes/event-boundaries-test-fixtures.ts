import { unzipSync } from 'fflate';
import { deviceToken, fakeAuth } from '../../../../test/helpers/index.ts';
import { InMemoryTemplateRegistry } from '../../../passkit/template/in-memory-registry.ts';
import type { PassJson } from '../../../passkit/types.ts';
import { createApp } from '../../app.ts';
import type { JobOf } from '../../jobs/types.ts';
import type { Clock } from '../../platform/clock.ts';
import { first, run } from '../../platform/db.ts';
import type { AppEnv } from '../../platform/env.ts';
import { createJobContext } from '../../platform/service-context.ts';
import { jobCtxOf } from '../delivery/delivery-test-fixtures.ts';
import { claimBoundaries, handleBoundaryRefresh } from './event-boundaries.ts';
import { ICON_PNG, type Kit, setupKit } from './pass-test-fixtures.ts';
import { publishPass } from './publish.ts';
import { stampBoundary } from './repo-boundary-stamp.ts';
import type { Pass } from './repo-map.ts';
import { getPass } from './repo-read-pass.ts';

export const MIN = 60_000;
export const HOUR = 60 * MIN;
export const TYPE = 'pass.im.plrs.wallet';
const ORIGIN = 'https://wallet.test';
export const iso = (ms: number) => new Date(ms).toISOString();

/** A season pass template: events from the `events` input, 90 minutes for an event without an end. */
export function seasonKit(config: Record<string, unknown> = {}): Promise<Kit> {
  return setupKit({
    template: (id) => {
      const registry = new InMemoryTemplateRegistry();
      const resolved = registry.add({
        id,
        orgId: null,
        version: 'v1',
        manifest: {
          schema: 1,
          name: 'Season',
          inputs: {
            type: 'object',
            required: ['memberName'],
            properties: {
              memberName: { type: 'string', minLength: 1 },
              tier: { type: 'string' },
              events: { type: 'array', items: { type: 'object' } },
            },
          },
          sample: { memberName: 'Alex Morgan' },
          bindings: [
            { to: { field: 'name' }, value: '{{memberName}}' },
            { to: { field: 'tier' }, value: '{{tier}}' },
          ],
          display: { title: '{{memberName}}' },
          behaviors: [
            {
              use: 'upcoming-events',
              version: 1,
              config: { input: 'events', fallbackMinutes: 90, ...config },
            },
          ],
        },
        passJson: {
          formatVersion: 1,
          passTypeIdentifier: 'placeholder',
          teamIdentifier: 'placeholder',
          serialNumber: 'placeholder',
          organizationName: 'placeholder',
          description: 'Test pass',
          generic: {
            primaryFields: [{ key: 'name', label: 'Member', value: '' }],
            secondaryFields: [{ key: 'tier', label: 'Tier', value: '', changeMessage: 'Tier: %@' }],
          },
        } as PassJson,
        assets: { 'icon.png': ICON_PNG },
      });
      return { resolved, registry };
    },
  });
}

export const events = (...rows: [string, number, number?][]) =>
  rows.map(([name, start, end]) => ({
    name,
    startsAt: iso(start),
    ...(end ? { endsAt: iso(end) } : {}),
  }));

/** A pass with this event list, published once. */
export async function seasonPass(
  kit: Kit,
  list: ReturnType<typeof events>,
  scope: { orgId?: string; mode?: 'live' | 'test'; memberName?: string; holderEmail?: string } = {},
): Promise<Pass> {
  const created = await kit.pass(scope);
  const memberName = scope.memberName ?? 'Alex Morgan';
  const published = await publishPass(jobCtxOf(kit), {
    passId: created.id,
    cause: 'admin',
    actor: { type: 'system', id: null },
    mutate: () => ({ personalization: { memberName, tier: 'Gold', events: list } }),
  });
  await kit.settle();
  return { ...published.pass, authToken: created.authToken };
}

/** One minute: the cron claims, then each queued job runs. Returns the jobs run. */
export async function tick(kit: Kit): Promise<number> {
  const ctx = jobCtxOf(kit);
  const from = kit.queue.sent.length;
  await claimBoundaries(ctx);
  const jobs = kit.queue.sent
    .splice(from)
    .filter(
      (m): m is JobOf<'pass.boundary_refresh'> =>
        (m as { kind?: string }).kind === 'pass.boundary_refresh',
    );
  for (const job of jobs) await handleBoundaryRefresh(job, ctx);
  await kit.settle();
  return jobs.length;
}

export interface BoundaryRow {
  due_at: number | null;
  rendered_at: number;
  stamp: number;
  attempts: number;
  render: string | null;
}

export const rowOf = (kit: Kit, passId: string) =>
  first<BoundaryRow>(
    kit.env.DB,
    'SELECT due_at, rendered_at, stamp, attempts, render FROM pass_boundaries WHERE pass_id = ?',
    [passId],
  );

/** Every column a version fence or an Apple tag reads, and the history row count. */
export const fenced = (kit: Kit, passId: string) =>
  first<Record<string, number | string>>(
    kit.env.DB,
    `SELECT version, revision, row_version, object_key, modified_at, lifecycle_generation,
       (SELECT COUNT(*) FROM pass_versions v WHERE v.pass_id = passes.id) AS versions
     FROM passes WHERE id = ?`,
    [passId],
  );

/** Marks the pass's earlier pushes as sent, so a later one is a new row, not a coalesced one. */
export const clearPushes = (kit: Kit, passId: string) =>
  kit.env.DB.prepare(
    "UPDATE outbox SET state = 'sent', coalesce_key = NULL WHERE pass_id = ? AND kind = 'push'",
  )
    .bind(passId)
    .run();

export const pendingPushes = async (kit: Kit, passId: string) =>
  (
    await first<{ n: number }>(
      kit.env.DB,
      "SELECT COUNT(*) AS n FROM outbox WHERE pass_id = ? AND kind = 'push' AND state != 'sent'",
      [passId],
    )
  )?.n ?? 0;

let app: ReturnType<typeof createApp> | undefined;
const call = (kit: Kit, path: string, init: RequestInit = {}) => {
  app ??= createApp({ stores: fakeAuth(ORIGIN).stores });
  return app.request(`${ORIGIN}/wallet/v1${path}`, init, kit.env);
};

/** The pass a registered device fetches, with its pass.json. */
export async function fetchApple(kit: Kit, pass: Pass, headers: Record<string, string> = {}) {
  const response = await call(kit, `/passes/${TYPE}/${pass.serial}`, {
    headers: { authorization: `ApplePass ${deviceToken(pass)}`, ...headers },
  });
  const bytes = new Uint8Array(await response.arrayBuffer());
  const files = response.status === 200 ? unzipSync(bytes) : {};
  const raw = files['pass.json'];
  return {
    status: response.status,
    etag: response.headers.get('etag'),
    lastModified: response.headers.get('last-modified'),
    files: Object.keys(files).sort(),
    json: raw ? (JSON.parse(new TextDecoder().decode(raw)) as PassJson) : null,
  };
}

/** Wallet's "serials updated since" call for a device. */
export async function updatedSince(kit: Kit, device: string, since: number | string) {
  const response = await call(
    kit,
    `/devices/${device}/registrations/${TYPE}?passesUpdatedSince=${since}`,
  );
  return response.status === 204
    ? null
    : await response.json<{ serialNumbers: string[]; lastUpdated: string }>();
}

export const active = (json: PassJson | null) =>
  ((json?.upcomingPassInformation ?? []) as { name: string; isActive: boolean }[])
    .filter((e) => e.isActive)
    .map((e) => e.name);

export const listed = (json: PassJson | null) =>
  ((json?.upcomingPassInformation ?? []) as { name: string }[]).map((e) => e.name);

/**
 * The write an event boundary makes, on any pass and template: a render with its own update tag and a
 * push, committed the way `handleBoundaryRefresh` commits it. For the fences of other modules' flows.
 */
export async function stampRender(
  env: AppEnv,
  clock: Clock,
  passId: string,
  keys: Record<string, unknown> = {},
): Promise<void> {
  const ctx = createJobContext(env, 'test', { clock });
  const pass = await getPass(env.DB, passId);
  if (!pass) throw new Error('Missing pass');
  const lease = clock.now() + 1;
  await run(
    env.DB,
    `INSERT INTO pass_boundaries (pass_id, version, object_key, due_at) VALUES (?, ?, ?, ?)
     ON CONFLICT (pass_id) DO UPDATE SET object_key = excluded.object_key, due_at = excluded.due_at`,
    [pass.id, pass.version, pass.objectKey, lease],
  );
  const outcome = await stampBoundary(
    ctx,
    { passId, objectKey: pass.objectKey, lease },
    pass,
    { renderedAt: clock.now(), render: JSON.stringify(keys), dueAt: null, now: clock.now() },
    `push:${passId}:boundary:${ctx.ids.id()}`,
  );
  if (outcome !== 'stamped') throw new Error(`render ${outcome}`);
}

/** pass.json inside a .pkpass, or inside the `<passId>.pkpass` entry of a .pkpasses. */
export function passJsonIn(bytes: Uint8Array, passId?: string): PassJson {
  const files = unzipSync(bytes);
  const inner = passId ? files[`${passId}.pkpass`] : undefined;
  const raw = (inner ? unzipSync(inner) : files)['pass.json'];
  if (!raw) throw new Error('No pass.json');
  return JSON.parse(new TextDecoder().decode(raw)) as PassJson;
}
