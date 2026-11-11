import { runInDurableObject } from 'cloudflare:test';
import { expect } from 'vitest';
import type { ScannerFixture } from '../../../../test/helpers/index.ts';
import type { ServiceContext } from '../../platform/service-context.ts';
import { putMemberPhoto } from '../passes/member-photo.ts';
import type { Pass } from '../passes/repo.ts';
import { makePng } from '../templates/package/fixtures.ts';
import { act } from './act.ts';
import { scannerActor, withRole } from './actor.ts';
import { actorCsrfAuthorityStmt } from './actor-csrf.ts';
import { publishScan } from './live.ts';
import { type LiveAttachment, type LiveRecipient, liveRecipient } from './live-auth.ts';
import {
  type InternalLiveRow,
  type LiveSourceProof,
  openLiveSourceProof,
} from './live-provenance.ts';
import { sameSnapshot } from './live-render.ts';
import { prepareLiveRow } from './live-render-plan.ts';
import { getScanner } from './repo-device.ts';
import { byIdStmt } from './repo-lookup.ts';
import { readScannerScope } from './repo-scope.ts';
import type { ScanEvaluation } from './scan-evaluation.ts';
import { hub, kit, screen, template } from './scan-hub-test-fixtures.ts';
import { bindScanningSession } from './scanning-workspace.ts';
import { codeOf, key, proofedScanActor } from './test-kit.ts';

export interface CatchupFixture {
  sources: [ScannerFixture, ScannerFixture, ScannerFixture];
  monitor: ScannerFixture & { attachment: LiveAttachment };
  passes: [Pass, Pass];
  inputs: [
    { code: string; method: 'camera' },
    { code: string; method: 'camera' },
    { code: string; method: 'camera' },
  ];
  evaluations: ScanEvaluation[];
  rows: [InternalLiveRow, InternalLiveRow, InternalLiveRow];
  proofs: [LiveSourceProof, LiveSourceProof, LiveSourceProof];
  recipient: LiveRecipient;
}

function requireThree<T>(values: T[]): asserts values is [T, T, T] {
  if (
    values.length !== 3 ||
    values[0] === undefined ||
    values[1] === undefined ||
    values[2] === undefined
  )
    throw new Error('Expected three catch-up values.');
}

/** Publish genuine evaluations from three separately paired scanners, including a presented miss. */
export async function catchupFixture(
  options: { separateTemplate?: boolean; photoSourceExpiresAt?: number } = {},
): Promise<CatchupFixture> {
  const ordinaryTemplate = options.separateTemplate
    ? await kit.scanTemplate('Independent live batch template', {
        actions: [{ id: 'check_in', label: 'Check in', kind: 'check_in' }],
      })
    : template;
  const sourceTemplates = [ordinaryTemplate, template, template];
  const sources = await Promise.all(
    sourceTemplates.map((id, index) =>
      kit.scanner({
        templateIds: [id],
        ...(index === 1 && options.photoSourceExpiresAt !== undefined
          ? { expiresAt: options.photoSourceExpiresAt }
          : {}),
      }),
    ),
  );
  requireThree(sources);
  const monitor = await screen(
    'monitor',
    sources.map((source) => source.id),
  );
  const passes: CatchupFixture['passes'] = [
    await kit.scanPass(ordinaryTemplate, { memberName: 'Catchup Ordinary' }),
    await kit.scanPass(template, { memberName: 'Catchup Photo' }),
  ];
  const png = btoa(String.fromCharCode(...makePng(270, 270)));
  await putMemberPhoto(
    kit.ctx,
    { type: 'system', id: null },
    passes[1].id,
    { png, includeInPass: false },
    null,
  );
  const inputs: CatchupFixture['inputs'] = [
    codeOf(passes[0]),
    codeOf(passes[1]),
    {
      code: `UNKNOWN-${kit.ctx.ids.token()}`,
      method: 'camera' as const,
    },
  ];
  const evaluations = [];
  for (const [index, source] of sources.entries()) {
    const scanner = await getScanner(kit.env.DB, source.id);
    if (!scanner) throw new Error('Missing source scanner.');
    const scope = await readScannerScope(kit.env.DB, scanner, scanner.staffId);
    const raw = scannerActor(kit.ctx, scanner, scanner.mode, 'cookie', scope);
    await bindScanningSession(kit.ctx, raw);
    const actor = await proofedScanActor(kit.ctx, withRole(raw, null));
    const input = inputs[index];
    if (!input) throw new Error('Missing source input.');
    const evaluation = await act(kit.ctx, actor, {
      input,
      actionId: 'auto',
      clientTs: kit.clock.now(),
      idempotencyKey: key(),
    });
    if (!evaluation.credentialContext) throw new Error('Missing original credential authority.');
    if (index < 2 && !evaluation.evaluatedSnapshot) throw new Error('Missing evaluated pass.');
    if (index === 2 && evaluation.evaluatedSnapshot) throw new Error('Expected a passless miss.');
    evaluations.push(evaluation);
    publishScan(
      kit.ctx,
      actor,
      evaluation.outcome,
      evaluation.evaluatedSnapshot,
      evaluation.credentialContext,
      'camera',
    );
    await kit.settle();
  }
  const sourceIds = new Set(sources.map((source) => source.id));
  const rows = await runInDurableObject(hub(), async (_object, state) =>
    ((await state.storage.get<InternalLiveRow[]>('recent')) ?? []).filter((row) =>
      sourceIds.has(row.scannerId),
    ),
  );
  expect(rows.map((row) => row.scannerId)).toEqual(sources.map((source) => source.id));
  expect(rows.map((row) => row.passId)).toEqual([passes[0].id, passes[1].id, null]);
  requireThree(rows);
  const proofs = (
    await Promise.all(rows.map((row) => openLiveSourceProof(kit.env, row.sourceProof)))
  ).map((proof) => {
    if (!proof) throw new Error('Missing genuine source proof.');
    return proof;
  });
  requireThree(proofs);
  const recipient = await liveRecipient(kit.ctx, monitor.attachment);
  if (!recipient) throw new Error('Missing live recipient.');
  return {
    sources,
    monitor,
    passes,
    inputs,
    evaluations,
    rows,
    proofs,
    recipient,
  };
}

export type SeenStatement = { sql: string; params: unknown[] };
export const isAcquisition = (statements: SeenStatement[]) =>
  statements.length > 3 && statements[0]?.sql.includes('session_watch') === true;
export const isFinal = (statements: SeenStatement[]) =>
  statements.some(({ sql }) => sql.includes('AS live_row_index'));

export async function catchupPlans(
  fixture: CatchupFixture,
  options: { indexes?: readonly number[]; ctx?: ServiceContext } = {},
) {
  const ctx = options.ctx ?? kit.ctx;
  const recipientCsrf = actorCsrfAuthorityStmt(ctx.env.DB, fixture.recipient.actor);
  if (!recipientCsrf) throw new Error('Missing recipient CSRF read.');
  const recipientResult = await recipientCsrf.all();
  const indexes = options.indexes ?? fixture.rows.map((_, index) => index);
  return Promise.all(
    indexes.map(async (index) => {
      const row = fixture.rows[index];
      const proof = fixture.proofs[index];
      if (!row || !proof) throw new Error('Missing live row or source proof.');
      const sourceCsrf = actorCsrfAuthorityStmt(ctx.env.DB, proof.actor);
      if (!sourceCsrf) throw new Error('Missing source CSRF read.');
      const sourceResult = await sourceCsrf.all();
      const candidate = row.passId
        ? await byIdStmt(ctx.env.DB, kit.org.id, row.passId).all()
        : undefined;
      const plan = await prepareLiveRow(
        ctx,
        fixture.recipient,
        row,
        proof,
        row.scannerId,
        candidate,
        { sourceResult, recipientResult },
        sameSnapshot,
      );
      if (!plan) throw new Error('Missing live row plan.');
      return plan;
    }),
  );
}
