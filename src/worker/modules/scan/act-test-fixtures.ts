import { expect } from 'vitest';
import { persistTemplate } from '../../../../test/helpers/index.ts';
import type { TemplateManifest } from '../../../passkit/types.ts';
import type { ScanOutcome } from '../../../shared/contracts/scan.ts';
import { all } from '../../platform/db.ts';
import { approveAppleRelease } from '../passes/apple-release-test-fixtures.ts';
import { ICON_PNG } from '../passes/pass-test-fixtures.ts';
import {
  originalScanLedger,
  retiredCredentialTombstone,
} from './repo-act-support-test-fixtures.ts';
import { key, type ScanKit, setupScanKit, startScanCredentialTransfer } from './test-kit.ts';

export let kit: ScanKit;
export let tpl: string;
export const MINUTE = 60_000;
export const HOUR = 60 * MINUTE;
export const CHECK_IN = { id: 'check_in', label: 'Check in', kind: 'check_in' } as const;

export async function setupActionFixture() {
  kit = await setupScanKit();
  tpl = await kit.scanTemplate('Gym card', { actions: [CHECK_IN] });
}

export const act = (
  headers: Record<string, string>,
  input: unknown,
  over: Record<string, unknown> = {},
) =>
  kit.post(headers, '/actions', {
    idempotencyKey: key(),
    input,
    clientTs: kit.clock.now(),
    actionId: 'auto',
    ...over,
  });
export const out = async (res: Response) => (await res.json()) as ScanOutcome;
export const mask = (o: ScanOutcome) => ({ ...o, scanId: null, at: null });
export const rows = <T>(sql: string, params: (string | number)[] = []) =>
  all<T>(kit.env.DB, sql, params);

export async function retireCredential(db: D1Database, passId: string, ref: string): Promise<void> {
  const transfer = await startScanCredentialTransfer(kit, passId, {
    db,
    target: { holderEmail: 'retired-scanner-credential@example.test', ownerUserId: null },
  });
  expect(transfer.transferId).toEqual(expect.any(String));
  expect(await retiredCredentialTombstone(db, passId, ref)).toEqual({ pass_id: passId });
}

export async function reviseReplayTemplate(
  id: string,
  edit: (manifest: TemplateManifest) => void,
  modes: readonly ('live' | 'test')[] = ['live', 'test'],
  db: D1Database = kit.env.DB,
) {
  const pinned = await kit.registry.resolve(id);
  const manifest = structuredClone(pinned.manifest);
  edit(manifest);
  const version = pinned.version === 'v1' ? 'v2' : 'v3';
  const revised = kit.registry.add({
    id,
    orgId: pinned.orgId,
    version,
    manifest,
    passJson: pinned.passJson,
    assets: { 'icon.png': ICON_PNG },
  });
  await persistTemplate(kit.fx, revised, {
    registry: kit.registry,
    buildKey: 'replay-compatible',
    db,
  });
  for (const mode of modes) await approveAppleRelease(kit, { templateId: id, version, mode, db });
}

/** A bare refusal that carries no pass, card, receipt or count. `reason` is not_found unless the scanner's own scope refuses it. */
export function expectUnavailable(
  replay: ScanOutcome,
  reason: 'not_found' | 'not_accepted' = 'not_found',
) {
  expect(replay).toMatchObject({
    kind: 'refused',
    reason,
    scanId: null,
    at: null,
    replay: false,
    action: null,
    card: null,
    template: null,
    previous: null,
    display: null,
    value: null,
    flags: [],
    undoUntil: null,
    cooldownRemainingMs: null,
    overridable: false,
    approvals: false,
    group: null,
    milestone: null,
    access: null,
    counts: { today: 0, event: null, asOf: 0, configRev: 0 },
  });
  expect(replay).not.toHaveProperty('checkIn');
}

export function expectReceipt(replay: ScanOutcome, original: ScanOutcome) {
  expect(original.scanId).toEqual(expect.any(String));
  expect(replay).toMatchObject({
    kind: original.kind,
    reason: original.reason,
    scanId: original.scanId,
    replay: true,
    previous: null,
    undoUntil: null,
    cooldownRemainingMs: null,
    overridable: false,
  });
}

export function expectRedactedReceipt(replay: ScanOutcome, original: ScanOutcome) {
  expectReceipt(replay, original);
  expect(replay).toMatchObject({
    action: null,
    card: null,
    template: null,
    display: null,
    value: null,
    flags: [],
    group: null,
    milestone: null,
    access: null,
    approvals: false,
  });
  expect(replay.checkIn).toBeUndefined();
}

export async function expectOriginalLedger(passId: string, scanId: string | null) {
  const events = await originalScanLedger(kit.env.DB, passId);
  expect(events).toHaveLength(1);
  const event = events[0];
  if (!event) throw new Error('Missing scan event');
  expect(JSON.parse(event.data)).toMatchObject({ scanId });
}
