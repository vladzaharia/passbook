import type { OpenAPIHono } from '@hono/zod-openapi';
import { createApp } from '../../app.ts';
import { denyAllStores } from '../../platform/auth.ts';
import type { AppBindings } from '../../platform/context.ts';
import { createSessionStore } from '../auth/sessions.ts';
import { scannerActor, scanScannerCsrfProof, withRole } from './actor.ts';
import { createScannerStore } from './auth-store.ts';
import { getScanner } from './repo-device.ts';
import {
  atMissStopCommit,
  missAudits,
  missCounter,
} from './repo-miss-integration-test-fixtures.ts';
import { readScannerScope } from './repo-scope.ts';
import { bindScanningSession } from './scanning-workspace.ts';
import { type ScanKit, setupScanKit } from './test-kit.ts';
import { captureTestEpochs } from './test-kit-epochs.ts';

let kit: ScanKit;
let templateId: string;
let app: OpenAPIHono<AppBindings>;
const WINDOW_MS = 10 * 60_000;

async function setupMissIntegration() {
  kit = await setupScanKit();
  templateId = await kit.scanTemplate('Miss accounting', {
    actions: [{ id: 'check_in', label: 'Check in', kind: 'check_in' }],
  });
  app = createApp({
    clock: kit.clock,
    stores: {
      ...denyAllStores,
      sessions: createSessionStore(kit.env, kit.clock),
      scanners: createScannerStore(kit.env, kit.clock),
    },
  });
}

const scopedKey = (orgId: string, mode: 'live' | 'test', actorKey: string) =>
  `scan:miss:${JSON.stringify([orgId, mode, actorKey])}`;
const windowStart = () => kit.clock.now() - (kit.clock.now() % WINDOW_MS);
const counter = (key: string, window = windowStart()) => missCounter(kit.env.DB, key, window);
const audits = (actorId: string) => missAudits(kit.env.DB, actorId);
const body = (idempotencyKey: string, code: string) => ({
  idempotencyKey,
  input: { code, method: 'camera' },
  clientTs: kit.clock.now(),
  actionId: 'auto',
});

async function actorFor(scannerId: string) {
  const scanner = await getScanner(kit.env.DB, scannerId);
  if (!scanner?.csrfSecret) throw new Error('Missing scanner credential');
  const scope = await readScannerScope(kit.env.DB, scanner, null);
  const actor = scannerActor(
    kit.ctx,
    { ...scanner, csrfSecret: null },
    scanner.mode,
    'cookie',
    scope,
  );
  actor.scannerCsrfProof = await scanScannerCsrfProof(kit.env, scanner.id, scanner.csrfSecret);
  await bindScanningSession(kit.ctx, actor);
  withRole(actor, null);
  // Like the route guard: epochs are captured once the session is bound.
  await captureTestEpochs(kit.ctx, actor);
  return actor;
}

async function atStopCommit(
  idempotencyKey: string,
  change: (db: D1Database, scanId: string) => Promise<unknown>,
  work: () => Promise<Response>,
): Promise<{ response: Response; scanId: string }> {
  return atMissStopCommit(kit.env, idempotencyKey, change, work);
}

export {
  actorFor,
  app,
  atStopCommit,
  audits,
  body,
  counter,
  kit,
  scopedKey,
  setupMissIntegration,
  templateId,
  WINDOW_MS,
  windowStart,
};
