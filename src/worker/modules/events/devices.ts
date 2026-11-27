import type {
  DeviceStatus,
  PassDevicesDto,
  PassSyncDeviceDto,
} from '../../../shared/contracts/events.ts';
import { NotFoundError } from '../../platform/errors.ts';
import type { ServiceContext } from '../../platform/service-context.ts';
import type { Pass } from '../passes/repo.ts';
import { getPass } from '../passes/repo-read-pass.ts';
import { removalVersion } from '../passes/repo-remove.ts';
import { readMode, type ScopeArg } from '../passes/scope.ts';
import { devicePassEnabled } from '../workbench/device-pass-identity.ts';
import { devicesOfPass } from '../workbench/repo-device-pass-devices.ts';
import { hashDevice } from './record.ts';
import { type LatestDeviceEvent, latestDeviceEvents, registrationsOfPass } from './repo.ts';
import { simulatedDevicesOfPass } from './repo-simulated.ts';

const num = (v: unknown): number | null => (typeof v === 'number' ? v : null);
const str = (v: unknown): string | null => (typeof v === 'string' ? v : null);
const dataOf = (e: LatestDeviceEvent | undefined): Record<string, unknown> =>
  e ? (JSON.parse(e.data) as Record<string, unknown>) : {};

interface Seen {
  registered?: LatestDeviceEvent;
  unregistered?: LatestDeviceEvent;
  file?: LatestDeviceEvent;
  push?: LatestDeviceEvent;
}

function fold(events: LatestDeviceEvent[]): Map<string, Seen> {
  const out = new Map<string, Seen>();
  for (const e of events) {
    const seen = out.get(e.device) ?? {};
    out.set(e.device, seen);
    if (e.kind === 'device.registered') seen.registered = e;
    else if (e.kind === 'device.unregistered') seen.unregistered = e;
    else if (e.kind === 'device.fetched') {
      if (dataOf(e).step === 'file') seen.file = e;
    } else if (!seen.push || e.at > seen.push.at) seen.push = e;
  }
  return out;
}

export function statusOf(input: {
  registered: boolean;
  version: number;
  fetch: { at: number; version: number } | null;
  push: { at: number; ok: boolean } | null;
  /** Registered after the current version was published, so it came with that version. */
  registeredCurrent?: boolean;
}): DeviceStatus {
  const { fetch, push } = input;
  if (!input.registered) return 'removed';
  if (push && !push.ok && (!fetch || push.at >= fetch.at)) return 'push_failing';
  if (fetch && fetch.version >= input.version) return 'current';
  if (input.registeredCurrent) return 'current';
  if (fetch || push) return 'waiting';
  return 'unknown';
}

function describe(
  pass: Pass,
  hash: string,
  seen: Seen,
  registeredAt: number | null,
  removal: { at: number; version: number | null } | null,
): PassSyncDeviceDto {
  const registered = registeredAt !== null;
  const fileData = dataOf(seen.file);
  const fetch =
    seen.file && num(fileData.version) !== null
      ? {
          at: seen.file.at,
          version: num(fileData.version) as number,
          httpStatus: num(fileData.status) ?? 200,
        }
      : null;
  const pushData = dataOf(seen.push);
  const push = seen.push
    ? {
        at: seen.push.at,
        ok: seen.push.kind === 'push.sent',
        version: num(pushData.version),
        httpStatus: num(pushData.status),
        reason: str(pushData.reason),
      }
    : null;
  const unregisteredAt = !registered && seen.unregistered ? seen.unregistered.at : null;
  let removalState: PassSyncDeviceDto['removal'] = null;
  if (removal) {
    if (!registered) removalState = 'deleted';
    else if (removal.version !== null) {
      if (registeredAt >= removal.at) removalState = 'fetched';
      else if (fetch && fetch.at >= removal.at && fetch.version >= removal.version)
        removalState = 'fetched';
      else removalState = 'pending';
    }
  }
  return {
    device: hash,
    status: statusOf({
      registered,
      version: pass.version,
      fetch,
      push,
      registeredCurrent: registeredAt !== null && registeredAt >= pass.modifiedAt,
    }),
    registeredAt,
    unregisteredAt,
    lastFetch: fetch,
    lastPush: push,
    removal: removalState,
  };
}

/**
 * One row per device that has or had the pass: the registrations now, plus devices the ledger saw
 * unregister. A status answers "did this device get the current version?".
 */
export async function listPassDevices(
  ctx: ServiceContext,
  passId: string,
  orgScope: ScopeArg,
): Promise<PassDevicesDto> {
  const db = ctx.env.DB;
  const pass = await getPass(db, passId, orgScope);
  if (!pass) throw new NotFoundError('Pass not found.', 'PASS_NOT_FOUND');
  const fence = { orgId: pass.orgId, mode: readMode(orgScope) };
  const pinnedScope =
    typeof orgScope === 'object' && orgScope !== null
      ? { ...orgScope, orgId: pass.orgId }
      : pass.orgId;
  const [registrations, simulatedRows, latest, removedVersion, phones] = await Promise.all([
    registrationsOfPass(db, passId, fence),
    simulatedDevicesOfPass(db, passId, pass.orgId),
    latestDeviceEvents(db, passId, fence),
    pass.removedAt !== null ? removalVersion(db, passId, pinnedScope) : null,
    // The developer's own phone, for a Test pass with device passes on (the Workbench shows it as "My phone").
    pass.mode === 'test' && devicePassEnabled(ctx.env) ? devicesOfPass(db, passId) : [],
  ]);
  const seen = fold(latest);
  const registeredAt = new Map<string, number>(
    await Promise.all(
      registrations.map(async (r) => [await hashDevice(r.device_id), r.created_at] as const),
    ),
  );
  // Devices made by Simulate: installed ones count as registered; removed ones show through their ledger row.
  const simulated = new Map<string, string>();
  for (const row of simulatedRows) {
    const hash = await hashDevice(row.id);
    simulated.set(hash, row.id);
    if (row.removed_at === null) registeredAt.set(hash, row.created_at);
  }
  const phone = new Map<string, boolean>();
  for (const row of phones) {
    const hash = await hashDevice(row.device_id);
    registeredAt.set(hash, row.created_at);
    phone.set(hash, (row.last_seen_at ?? 0) >= row.updated_at);
  }
  const removal = pass.removedAt !== null ? { at: pass.removedAt, version: removedVersion } : null;
  const hashes = new Set([...registeredAt.keys(), ...seen.keys()]);
  const devices: PassSyncDeviceDto[] = [];
  for (const hash of hashes) {
    const s = seen.get(hash) ?? {};
    const at = registeredAt.get(hash) ?? null;
    // A device that unregistered before the removal never had the final version to fetch.
    if (at === null && removal && s.unregistered && s.unregistered.at < removal.at) continue;
    if (at === null && !s.unregistered) continue;
    const device = describe(pass, hash, s, at, removal);
    const simulatedId = simulated.get(hash);
    const seenCurrent = phone.get(hash);
    if (seenCurrent !== undefined) {
      // A device pass is rebuilt on demand: the phone is current once it has fetched since the last change.
      const status =
        device.status === 'push_failing' ? device.status : seenCurrent ? 'current' : 'waiting';
      devices.push({ ...device, status, devicePass: true });
    } else
      devices.push(simulatedId ? { ...device, simulated: true, deviceId: simulatedId } : device);
  }
  devices.sort(
    (a, b) =>
      Number(b.registeredAt !== null) - Number(a.registeredAt !== null) ||
      (b.registeredAt ?? b.unregisteredAt ?? 0) - (a.registeredAt ?? a.unregisteredAt ?? 0),
  );
  return {
    version: pass.version,
    devices,
    removal: removal
      ? {
          removedAt: removal.at,
          version: removal.version,
          total: devices.length,
          done: devices.filter((d) => d.removal === 'fetched' || d.removal === 'deleted').length,
        }
      : null,
  };
}
