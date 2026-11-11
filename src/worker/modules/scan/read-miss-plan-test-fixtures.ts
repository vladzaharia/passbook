import { ensureCredentialRefKeyset } from '../passes/credential-keyset.ts';
import { scannerActor, scanScannerCsrfProof, withRole } from './actor.ts';
import { actorCsrfFence } from './actor-csrf.ts';
import { credentialTombstoneRefsForInput } from './credential-input.ts';
import { getScanner } from './repo-device.ts';
import { missCounterKey, type ReadMissFence } from './repo-miss-authority.ts';
import {
  readMissAuditCount,
  readMissCandidates,
  readMissCounter,
} from './repo-read-miss-plan-test-fixtures.ts';
import { readScannerScope } from './repo-scope.ts';
import { bindScanningSession } from './scanning-workspace.ts';
import { type ScanKit, setupScanKit } from './test-kit.ts';

let kit: ScanKit;
let templateId: string;
const WINDOW_MS = 10 * 60_000;

async function setupReadMissPlan() {
  kit = await setupScanKit();
  await ensureCredentialRefKeyset(kit.env.DB, kit.env);
  templateId = await kit.scanTemplate('Read miss plan', {
    actions: [{ id: 'check_in', label: 'Check in', kind: 'check_in' }],
  });
}

async function fixture() {
  const scanner = await kit.scanner({ templateIds: [templateId] });
  const row = await getScanner(kit.env.DB, scanner.id);
  if (!row?.csrfSecret) throw new Error('Missing scanner CSRF fixture');
  const scope = await readScannerScope(kit.env.DB, row, null);
  const actor = scannerActor(kit.ctx, { ...row, csrfSecret: null }, row.mode, 'cookie', scope);
  actor.scannerCsrfProof = await scanScannerCsrfProof(kit.env, row.id, row.csrfSecret);
  await bindScanningSession(kit.ctx, actor);
  withRole(actor, null);
  const query = `READ-MISS-${scanner.id}`;
  const credentials = await credentialTombstoneRefsForInput(
    kit.ctx,
    actor.orgId,
    actor.mode,
    { code: query, method: 'camera' },
    true,
    'defer',
  );
  actor.credentialKeysetCommitment = credentials.credentialKeysetCommitment;
  const csrf = await actorCsrfFence(kit.ctx, actor);
  if (!csrf) throw new Error('Missing original actor CSRF fence');
  const candidates = readMissCandidates(actor.orgId, actor.mode, query);
  const fence: ReadMissFence = { csrf, credentials, candidates, visible: [] };
  const window = kit.clock.now() - (kit.clock.now() % WINDOW_MS);
  const key = missCounterKey(actor);
  const counter = () => readMissCounter(kit.env.DB, key, window);
  const auditCount = () => readMissAuditCount(kit.env.DB, scanner.id);
  return {
    scanner,
    actor,
    csrfSecret: row.csrfSecret,
    credentials,
    fence,
    query,
    window,
    key,
    counter,
    auditCount,
  };
}

export { fixture, kit, setupReadMissPlan, templateId };
