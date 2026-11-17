import { first } from '../../platform/db.ts';
import { ensureCredentialRefKeyset } from '../passes/credential-keyset.ts';
import { scannerActor, scanScannerCsrfProof, withRole } from './actor.ts';
import { credentialTombstoneRefsForInput } from './credential-input.ts';
import type { ReadMissObservation } from './misses.ts';
import { getScanner } from './repo-device.ts';
import { missCounterKey, missWindow } from './repo-miss-authority.ts';
import { readScannerScope } from './repo-scope.ts';
import { bindScanningSession } from './scanning-workspace.ts';
import { type ScanKit, setupScanKit } from './test-kit.ts';
import { captureTestEpochs } from './test-kit-epochs.ts';

let kit: ScanKit;
let templateId: string;
const WINDOW_MS = 10 * 60_000;

async function setupReadMissGrant() {
  kit = await setupScanKit();
  await ensureCredentialRefKeyset(kit.env.DB, kit.env);
  templateId = await kit.scanTemplate('Read miss grant', {
    actions: [{ id: 'check_in', label: 'Check in', kind: 'check_in' }],
  });
}

/** A scanner, its actor as the guard builds it, and the miss of a code no pass has (matched by external id). */
async function fixture() {
  const scanner = await kit.scanner({ templateIds: [templateId] });
  const row = await getScanner(kit.env.DB, scanner.id);
  if (!row?.csrfSecret) throw new Error('Missing scanner fixture');
  const scope = await readScannerScope(kit.env.DB, row, null);
  const actor = scannerActor(kit.ctx, { ...row, csrfSecret: null }, row.mode, 'cookie', scope);
  actor.scannerCsrfProof = await scanScannerCsrfProof(kit.env, row.id, row.csrfSecret);
  await bindScanningSession(kit.ctx, actor);
  withRole(actor, null);
  await captureTestEpochs(kit.ctx, actor);
  const query = `READ-MISS-${scanner.id}`;
  const credentials = await credentialTombstoneRefsForInput(
    kit.ctx,
    actor.orgId,
    actor.mode,
    { code: query, method: 'camera' },
    true,
    'defer',
  );
  const observation: ReadMissObservation = {
    refs: credentials.credentialTombstoneRefs,
    unchanged: missWindow(
      'NOT EXISTS (SELECT 1 FROM passes p WHERE p.org_id = {org} AND p.mode = {mode} AND p.external_id = ?)',
      [query],
    ),
  };
  const window = kit.clock.now() - (kit.clock.now() % WINDOW_MS);
  const key = missCounterKey(actor);
  return {
    scanner,
    actor,
    credentials,
    observation,
    query,
    window,
    key,
    counter: () =>
      first<{ count: number }>(
        kit.env.DB,
        'SELECT count FROM counters WHERE key=? AND window_start=?',
        [key, window],
      ),
    auditCount: () =>
      first<{ count: number }>(
        kit.env.DB,
        "SELECT COUNT(*) AS count FROM audit_log WHERE action='scan.misses_capped' AND actor_id=?",
        [scanner.id],
      ),
  };
}

export { fixture, kit, setupReadMissGrant, templateId };
