import { expect } from 'vitest';
import { persistTemplate } from '../../../../test/helpers/index.ts';
import type { TemplateManifest } from '../../../passkit/types.ts';
import { type ScanOutcome, ScanOutcomeSchema } from '../../../shared/contracts/scan.ts';
import { jobCtxOf } from '../delivery/delivery-test-fixtures.ts';
import { approveAppleRelease } from '../passes/apple-release-test-fixtures.ts';
import { putPassCheckIn } from '../passes/check-in.ts';
import { putMemberPhoto } from '../passes/member-photo.ts';
import { ICON_PNG } from '../passes/pass-test-fixtures.ts';
import { makePng } from '../templates/package/fixtures.ts';
import { beforeBatch } from './repo-action-template-read-race-test-fixtures.ts';
import { key, makeLegacyScanPass, type ScanKit } from './test-kit.ts';

export const ACTION = { id: 'check_in', label: 'Check in', kind: 'check_in' } as const;
export const PRIVATE = 'Private Cedar Member';
const system = { type: 'system' as const, id: null };

export async function fixture(
  kit: ScanKit,
  options: {
    legacy?: boolean;
    choose?: boolean;
    stop?: boolean;
    photo?: boolean;
    event?: boolean;
    history?: boolean;
    compatiblePin?: boolean;
    includeInPass?: boolean;
  } = {},
) {
  let templateId = await kit.scanTemplate(
    'Captured action template',
    {
      actions: [ACTION],
      ...(options.stop
        ? { flags: [{ input: 'tier', label: 'Review', equals: ['review'], stop: true }] }
        : {}),
      display: {
        v: 1,
        header: options.history ? { subtitle: '{{history.lastScan.action}}' } : {},
        photo: { minRole: 'door' },
        ...(options.history
          ? {
              panels: [
                {
                  id: 'p_history',
                  rows: [
                    {
                      id: 'r_history',
                      type: 'history' as const,
                      source: 'scans' as const,
                      show: ['action' as const, 'where' as const],
                    },
                  ],
                },
              ],
            }
          : {}),
      },
    },
    options.legacy ? { releaseModes: [] } : undefined,
  );
  if (options.compatiblePin) {
    if (options.legacy) throw new Error('Cannot combine legacy and compatible-release fixtures');
    const base = await kit.registry.resolve(templateId, 'v1');
    templateId = `${templateId}-compatible`;
    const compatible = kit.registry.add({
      id: templateId,
      orgId: kit.org.id,
      version: 'v1',
      manifest: base.manifest,
      passJson: base.passJson,
      assets: { 'icon.png': ICON_PNG },
    });
    await persistTemplate(kit.fx, compatible, { registry: kit.registry, buildKey: 'same-build' });
    await approveAppleRelease(kit, { templateId, version: 'v1', mode: 'live' });
  }
  const pinned = await kit.registry.resolve(templateId, 'v1');
  const pass = options.legacy
    ? await makeLegacyScanPass(kit.fx, {
        orgId: kit.org.id,
        template: pinned,
        personalization: { memberName: PRIVATE, tier: options.stop ? 'review' : 'gold' },
      })
    : await kit.scanPass(templateId, {
        memberName: PRIVATE,
        tier: options.stop ? 'review' : 'gold',
      });
  const event = options.event ? await kit.event({ templateIds: [templateId] }) : null;
  if (event)
    await putPassCheckIn(kit.ctx, system, pass.id, { mode: 'in_out', eventId: event.id }, null);
  if (options.photo)
    await putMemberPhoto(
      options.includeInPass ? jobCtxOf(kit) : kit.ctx,
      system,
      pass.id,
      {
        png: btoa(String.fromCharCode(...makePng(270, 270))),
        includeInPass: options.includeInPass ?? false,
      },
      null,
    );
  const scanner = await kit.scanner({
    templateIds: [templateId],
    settings: { flow: options.choose ? 'choose' : 'auto', letInAgain: 'anyone' },
  });
  return { templateId, pinned, pass, event, scanner };
}

export async function stageVersion(
  kit: ScanKit,
  templateId: string,
  version = 'v2',
  edit: (manifest: TemplateManifest) => void = () => {},
  buildKey: string | null = 'different-build',
) {
  const pinned = await kit.registry.resolve(templateId, 'v1');
  const manifest = structuredClone(pinned.manifest);
  edit(manifest);
  const next = kit.registry.add({
    id: templateId,
    orgId: kit.org.id,
    version,
    manifest,
    passJson: pinned.passJson,
    assets: { 'icon.png': ICON_PNG },
  });
  await persistTemplate(kit.fx, next, { registry: kit.registry, buildKey });
  return next;
}

export function body(kit: ScanKit, passId: string, over: Record<string, unknown> = {}) {
  return {
    idempotencyKey: key(),
    input: { passId, method: 'manual' as const },
    clientTs: kit.clock.now(),
    actionId: 'auto',
    ...over,
  };
}

export async function action(kit: ScanKit, headers: Record<string, string>, request: unknown) {
  const response = await kit.post(headers, '/actions', request);
  expect(response.status).toBe(200);
  return ScanOutcomeSchema.parse(await response.json());
}

/** Run the action with a change landing just before the batch that matches `marker`; the raw response. */
export async function raceRaw(
  kit: ScanKit,
  headers: Record<string, string>,
  request: unknown,
  marker: string,
  change: (db: D1Database) => Promise<unknown>,
) {
  const real = kit.env.DB;
  const intercepted = beforeBatch(real, marker, change);
  Object.assign(kit.env, { DB: intercepted.db });
  try {
    const response = await kit.post(headers, '/actions', request);
    expect(intercepted.fired()).toBe(true);
    return response;
  } finally {
    Object.assign(kit.env, { DB: real });
  }
}

export async function race(
  kit: ScanKit,
  headers: Record<string, string>,
  request: unknown,
  marker: string,
  change: (db: D1Database) => Promise<unknown>,
) {
  const response = await raceRaw(kit, headers, request, marker, change);
  expect(response.status).toBe(200);
  return ScanOutcomeSchema.parse(await response.json());
}

/** A classified refusal: its status and code, never a pass-revealing body. */
export async function expectClassified(
  response: Response,
  code: 'SCAN_PASS_CHANGED' | 'SCAN_CONFIG_CHANGED' | 'SCAN_STAFF_CHANGED' | 'SCANNER_REPAIR',
) {
  const text = await response.text();
  const body = JSON.parse(text) as { code?: string };
  expect(`${response.status} ${body.code}`).toBe(
    `${code === 'SCANNER_REPAIR' ? 401 : 409} ${code}`,
  );
  for (const value of [PRIVATE, 'member.png', 'assetGrant']) expect(text).not.toContain(value);
}

export function expectUnavailable(result: ScanOutcome, passId: string) {
  expect(result).toMatchObject({
    kind: 'refused',
    reason: 'not_found',
    scanId: null,
    action: null,
    card: null,
    display: null,
    template: null,
    previous: null,
  });
  const text = JSON.stringify(result);
  for (const value of [passId, PRIVATE, 'member.png', 'assetGrant'])
    expect(text).not.toContain(value);
}

/**
 * The stop commits in its own batch and its photo grants in the next. A template change between
 * them is content: the stop stays recorded and only the grants are withheld.
 */
export function expectStopRecordedWithoutGrants(result: ScanOutcome) {
  expect(result).toMatchObject({ kind: 'heads_up', reason: 'check_required' });
  expect(result.scanId).toEqual(expect.any(String));
  expect(result.display?.identity.photo?.url ?? null).toBeNull();
  expect(JSON.stringify(result)).not.toContain('assetGrant');
}
