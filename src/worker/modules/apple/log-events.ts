import type { ServiceContext } from '../../platform/service-context.ts';
import { type PassEventInput, recordPassEvents } from '../events/record.ts';
import { pendingFetchDevices } from '../events/repo.ts';
import type { Pass } from '../passes/repo.ts';
import { passesBySerials } from './repo.ts';

const SERIAL_LIKE = /[A-Za-z0-9][A-Za-z0-9._-]{7,63}/g;
const MAX_CANDIDATES = 100;
/** A device that checked in this recently, and has not fetched the file yet, is the one fetching. */
const ATTRIBUTION_WINDOW_MS = 120_000;

/**
 * Wallet's log endpoint carries no device or pass. A line that names a serial we know is attached
 * to that pass as `device.log`; other lines stay in the identity-level log.
 */
export async function attachLogLines(ctx: ServiceContext, lines: string[]): Promise<void> {
  const byLine = lines.map((line) => [...new Set(line.match(SERIAL_LIKE) ?? [])].slice(0, 6));
  const candidates = [...new Set(byLine.flat())].slice(0, MAX_CANDIDATES);
  const passes = new Map((await passesBySerials(ctx.env.DB, candidates)).map((p) => [p.serial, p]));
  if (passes.size === 0) return;
  const inputs: PassEventInput[] = [];
  lines.forEach((line, i) => {
    const pass = byLine[i]?.map((s) => passes.get(s)).find((p) => p !== undefined);
    if (pass)
      inputs.push({
        orgId: pass.orgId,
        passId: pass.id,
        mode: pass.mode,
        kind: 'device.log',
        data: { line: line.slice(0, 300) },
      });
  });
  await recordPassEvents(ctx, inputs);
}

/**
 * The pass file request carries no device id, so a fetch is credited to the devices that checked
 * in for this pass in the last two minutes and have not fetched yet. With none, it is recorded
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
