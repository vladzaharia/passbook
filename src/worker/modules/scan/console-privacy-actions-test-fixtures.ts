import { expect } from 'vitest';
import type { ScannerFixture } from '../../../../test/helpers/index.ts';
import { type ScanOutcome, ScanOutcomeSchema } from '../../../shared/contracts/scan.ts';
import type { Pass } from '../passes/repo.ts';
import { expectNoSecrets, kit, PUBLIC } from './console-privacy-test-fixtures.ts';
import { findScanClaim } from './repo-console-privacy-test-fixtures.ts';
import { codeOf, key } from './test-kit.ts';

export async function action(scanner: ScannerFixture, pass: Pass, actionId = 'check_in') {
  const request = {
    idempotencyKey: key(),
    input: codeOf(pass),
    clientTs: kit.clock.now(),
    actionId,
  };
  const send = () => kit.post(scanner.headers, '/actions', request);
  const response = await send();
  expect(response.status).toBe(200);
  const original: ScanOutcome = await response.json();
  ScanOutcomeSchema.parse(original);
  expect(original).toMatchObject({ kind: 'ok', reason: null, replay: false });
  expect(original.scanId).toEqual(expect.any(String));
  return { original, request, send };
}

export async function recordedCheckIn(
  scanner: ScannerFixture,
  passId: string,
  actionId = 'check_in',
) {
  kit.clock.advance(1000);
  const response = await kit.post(scanner.headers, '/actions', {
    idempotencyKey: key(),
    input: { passId, method: 'manual' },
    clientTs: kit.clock.now(),
    actionId,
  });
  expect(response.status).toBe(200);
  const outcome: ScanOutcome = await response.json();
  ScanOutcomeSchema.parse(outcome);
  expect(outcome).toMatchObject({ kind: 'ok', reason: null, replay: false });
  if (!outcome.scanId || outcome.at === null)
    throw new Error('A successful scan must have an id and time.');
  return { id: outcome.scanId, at: outcome.at };
}

export async function recordedNoMatch(scanner: ScannerFixture) {
  kit.clock.advance(1000);
  const response = await kit.post(scanner.headers, '/actions', {
    idempotencyKey: key(),
    input: { code: `NO-MATCH-${key()}`, method: 'camera' },
    clientTs: kit.clock.now(),
    actionId: 'check_in',
  });
  expect(response.status).toBe(200);
  const outcome: ScanOutcome = await response.json();
  ScanOutcomeSchema.parse(outcome);
  expect(outcome).toMatchObject({ kind: 'refused', reason: 'not_found', replay: false });
  if (!outcome.scanId || outcome.at === null)
    throw new Error('A no-match scan must have an id and time.');
  return { id: outcome.scanId, at: outcome.at };
}

export async function replay(send: () => Promise<Response>) {
  const response = await send();
  expect(response.status).toBe(200);
  const data: ScanOutcome = await response.json();
  ScanOutcomeSchema.parse(data);
  if (data.replay) {
    expect(data).toMatchObject({
      display: null,
      card: null,
      template: null,
      previous: null,
      undoUntil: null,
      approvals: false,
      overridable: false,
      counts: { today: 0, event: null, asOf: 0, configRev: 0 },
    });
    expect(data).not.toHaveProperty('checkIn');
  }
  return data;
}

export function expectMasked(outcome: ScanOutcome, original: ScanOutcome, pass: Pass) {
  expect(outcome).toMatchObject({
    kind: 'refused',
    scanId: null,
    display: null,
    card: null,
    action: null,
    template: null,
    previous: null,
    undoUntil: null,
  });
  expectNoSecrets(outcome, pass);
  expect(JSON.stringify(outcome)).not.toContain(PUBLIC);
  expect(JSON.stringify(outcome)).not.toContain(pass.id);
  if (!original.scanId) throw new Error('The original scan must have an id.');
  expect(JSON.stringify(outcome)).not.toContain(original.scanId);
}

export function expectSafeReceipt(outcome: ScanOutcome, original: ScanOutcome, pass: Pass) {
  expect(outcome).toMatchObject({
    kind: original.kind,
    scanId: original.scanId,
    replay: true,
    action: null,
    undoUntil: null,
    overridable: false,
  });
  expectNoSecrets(outcome, pass);
}

export function expectRedactedReceipt(outcome: ScanOutcome, original: ScanOutcome, pass: Pass) {
  expect(outcome).toMatchObject({
    kind: original.kind,
    scanId: original.scanId,
    replay: true,
    undoUntil: null,
    overridable: false,
  });
  expectNoSecrets(outcome, pass);
  expect(JSON.stringify(outcome)).not.toContain(PUBLIC);
  expect(JSON.stringify(outcome)).not.toContain(pass.id);
}

export async function expectOneClaim(scanner: ScannerFixture, idempotencyKey: string) {
  expect(await findScanClaim(kit, scanner, idempotencyKey)).toEqual({ n: 1 });
}
