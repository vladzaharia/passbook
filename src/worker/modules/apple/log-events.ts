import type { ServiceContext } from '../../platform/service-context.ts';
import { hashDevice, type PassEventInput, recordPassEvents } from '../events/record.ts';
import { pendingFetchDevices } from '../events/repo.ts';
import type { Pass } from '../passes/repo.ts';
import { anyRegisteredDevice, identityByPassType, passesBySerials } from './repo.ts';

const SERIAL_LIKE = /[A-Za-z0-9][A-Za-z0-9._-]{7,63}/g;
const PASS_TYPE = /pass type ([A-Za-z0-9._-]+)/i;
const DEVICE_ID = /(\bdevice )([^\s,;)]+)|\b[0-9a-f]{24,}\b/gi;
const MAX_CANDIDATES = 100;
/** A device that checked in this recently, and has not fetched the file yet, is the one fetching. */
const ATTRIBUTION_WINDOW_MS = 120_000;

/** Device library ids unlock the serials list, so a stored line carries only their hash. */
async function maskDevices(line: string): Promise<string> {
  const found = new Map<string, string>();
  for (const m of line.matchAll(DEVICE_ID)) {
    const id = m[2] ?? m[0];
    if (!found.has(id)) found.set(id, await hashDevice(id));
  }
  return line.replace(DEVICE_ID, (all, prefix: string | undefined, id: string | undefined) =>
    prefix ? `${prefix}${found.get(id ?? '')}` : (found.get(all) ?? '[device]'),
  );
}

/** The raw device ids a line names. */
const deviceIdsOf = (line: string) =>
  [...line.matchAll(DEVICE_ID)].map((m) => m[2] ?? m[0]).filter((id) => id !== undefined);

/**
 * Wallet's log endpoint carries no device or pass and takes unauthenticated posts. A line is
 * attached to a pass as `device.log` only when it names the pass type, a serial of that identity and
 * a device registered to that pass, so knowing a serial is not enough to write into a pass's Sync
 * log. Attached lines carry `unverified`; other lines stay in the identity-level log. A serial
 * shared by several passes of the identity is skipped.
 */
export async function attachLogLines(ctx: ServiceContext, lines: string[]): Promise<void> {
  const identities = new Map<string, string | null>();
  const parsed: { line: string; identityId: string; serials: string[] }[] = [];
  for (const line of lines) {
    const type = PASS_TYPE.exec(line)?.[1];
    if (!type) continue;
    if (!identities.has(type))
      identities.set(type, (await identityByPassType(ctx.env.DB, type))?.id ?? null);
    const identityId = identities.get(type);
    const serials = [...new Set(line.match(SERIAL_LIKE) ?? [])].slice(0, 6);
    if (identityId && serials.length > 0) parsed.push({ line, identityId, serials });
  }
  const inputs: PassEventInput[] = [];
  for (const identityId of new Set(parsed.map((p) => p.identityId))) {
    const mine = parsed.filter((p) => p.identityId === identityId);
    const candidates = [...new Set(mine.flatMap((p) => p.serials))].slice(0, MAX_CANDIDATES);
    const bySerial = new Map<string, Awaited<ReturnType<typeof passesBySerials>>>();
    for (const pass of await passesBySerials(ctx.env.DB, identityId, candidates))
      bySerial.set(pass.serial, [...(bySerial.get(pass.serial) ?? []), pass]);
    for (const { line, serials } of mine) {
      const owners = serials.map((s) => bySerial.get(s)).find((l) => l !== undefined);
      const pass = owners?.length === 1 ? owners[0] : undefined;
      if (!pass || !(await anyRegisteredDevice(ctx.env.DB, pass.id, deviceIdsOf(line)))) continue;
      inputs.push({
        orgId: pass.orgId,
        passId: pass.id,
        mode: pass.mode,
        kind: 'device.log',
        data: { line: (await maskDevices(line)).slice(0, 300), unverified: true },
      });
    }
  }
  await recordPassEvents(ctx, inputs);
}

/**
 * The pass file request carries no device id, so a fetch is credited to the earliest device that
 * checked in for this pass in the last two minutes and has not fetched yet. With none, it is recorded
 * without a device.
 */
export async function recordPassFetch(
  ctx: ServiceContext,
  pass: Pick<Pass, 'id' | 'orgId' | 'mode' | 'version'>,
  httpStatus: number,
): Promise<void> {
  if (httpStatus !== 200 && httpStatus !== 304) return;
  const now = ctx.clock.now();
  const devices = await pendingFetchDevices(ctx.env.DB, pass.id, now - ATTRIBUTION_WINDOW_MS).catch(
    (error: unknown) => {
      ctx.log.warn('events.attribution_failed', { code: 'EVENT_ATTRIBUTION', error });
      return [];
    },
  );
  const base = {
    orgId: pass.orgId,
    passId: pass.id,
    mode: pass.mode,
    kind: 'device.fetched' as const,
    data: { step: 'file', version: pass.version, status: httpStatus },
  };
  await recordPassEvents(
    ctx,
    devices.length > 0 ? devices.map((deviceHash) => ({ ...base, deviceHash })) : [base],
  );
}
