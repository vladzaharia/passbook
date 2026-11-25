import type { WorkflowStep } from 'cloudflare:workers';
import {
  makeApiKey,
  makeScanEvent,
  makeScanner,
  makeScanStaff,
  makeTemplate,
  persistTemplate,
  saveOrgSettings,
} from '../../../../test/helpers/index.ts';
import { run } from '../../platform/db.ts';
import { recordAudit } from '../audit/service.ts';
import type { RetentionKit } from '../retention/retention-test-fixtures.ts';
import { credential } from '../wallet-providers/repo-wallet-credentials-test-fixtures.ts';
import { seedWaveTables } from './lifecycle-wave-test-fixtures.ts';

/** A workflow step that runs its callback in place; `crashAfter` throws on the next step after that many. */
/** `clock` moves to a `sleepUntil` time, as a waiting workflow would find it on waking. */
export function fakeStep(
  crashAfter?: number,
  clock?: { advance(ms: number): void; now(): number },
) {
  let n = 0;
  const step = {
    async do(_name: string, a: unknown, b?: unknown) {
      if (crashAfter !== undefined && n++ >= crashAfter) throw new Error('crash');
      return ((typeof a === 'function' ? a : b) as () => unknown)();
    },
    async sleep() {},
    async sleepUntil(_name: string, until: Date) {
      if (clock && until.getTime() > clock.now()) clock.advance(until.getTime() - clock.now());
    },
  };
  return step as unknown as Pick<WorkflowStep, 'do' | 'sleep' | 'sleepUntil'>;
}

export interface Populated {
  orgId: string;
  adminUserId: string;
  passes: string[];
  holderEmail: string;
  templateId: string;
}

/** An org with an admin, passes in both modes, a device, a template of its own, scanning, a key and settings. */
export async function populateOrg(rk: RetentionKit, label: string): Promise<Populated> {
  const { kit } = rk;
  const { fx, env, clock, ctx } = kit;
  const admin = await rk.org(['org_admin']);
  const orgId = admin.orgId;
  const holderEmail = `holder-${label}@example.test`;
  const live = await kit.pass({ orgId, holderEmail, memberName: `${label} One` });
  const second = await kit.pass({ orgId, memberName: `${label} Two` });
  const test = await kit.pass({ orgId, mode: 'test' });
  await kit.device(live, `device-${label}`, 'push-token');
  const template = makeTemplate({ id: `tpl-${label}`, orgId });
  await persistTemplate(fx, template.resolved, { registry: template.registry });
  await env.BUCKET.put(`templates/${orgId}/tpl-${label}/v1/icon.png`, new Uint8Array([1, 2, 3]));
  const event = await makeScanEvent(fx, { orgId });
  const scanner = await makeScanner(fx, { orgId, eventId: event.id });
  await makeScanStaff(fx, { orgId });
  await makeApiKey(fx, { orgId });
  await saveOrgSettings(env.DB, orgId, { 'retention.eventsDays': 120 }, clock.now());
  await run(
    env.DB,
    `INSERT INTO scans (id, org_id, mode, pass_id, event_id, actor_type, actor_id, actor_key, idempotency_key,
       request_hash, method, at) VALUES (?, ?, 'live', ?, ?, 'system', 'sys', ?, ?, 'h', 'camera', ?)`,
    [fx.ids.id(), orgId, live.id, event.id, `k-${label}`, `i-${label}`, clock.now()],
  );
  await run(
    env.DB,
    `INSERT INTO pass_notes (id, org_id, mode, pass_id, credential_generation, body, author_name, idempotency_key, created_at)
     VALUES (?, ?, 'live', ?, 1, ?, 'Desk', ?, ?)`,
    [fx.ids.id(), orgId, live.id, `note-${label}`, `n-${label}`, clock.now()],
  );
  await run(
    env.DB,
    "INSERT INTO idempotency_keys (org_id, key, request_hash, created_at) VALUES (?, ?, 'h', ?)",
    [orgId, `key-${label}`, clock.now()],
  );
  await run(
    env.DB,
    "INSERT INTO workflow_runs (instance_id, kind, org_id, started_at) VALUES (?, 'bulk_reissue', ?, ?)",
    [`run-${label}`, orgId, clock.now()],
  );
  await env.BUCKET.put(`member-photos/${orgId}/pending/x.png`, new Uint8Array([1]));
  await env.BUCKET.put(`uploads/up-${label}.zip`, new Uint8Array([1]));
  await env.BUCKET.put(`uploads/up-${label}/x/tooling.json`, new Uint8Array([1]));
  await run(
    env.DB,
    'INSERT INTO template_imports (upload_id, org_id, object_key, created_at, updated_at) VALUES (?, ?, ?, 1, 1)',
    [`up-${label}`, orgId, `uploads/up-${label}.zip`],
  );
  await credential({ orgId, scope: 'org' });
  const blob = new Uint8Array(16).fill(7);
  const secret = `secret-${label}`;
  await run(
    env.DB,
    "INSERT INTO credentials (id, kind, org_id, kek_version, iv, wrapped_dek, ciphertext, created_at) VALUES (?, 'pass_signer', ?, 1, ?, ?, ?, 1)",
    [secret, orgId, blob, blob, blob],
  );
  await run(
    env.DB,
    `INSERT INTO signing_identities (id, org_id, label, pass_type_identifier, team_identifier, source, credential_id, created_at)
     VALUES (?, ?, 'Own', ?, 'TEAM', 'db', ?, 1)`,
    [`identity-${label}`, orgId, `pass.test.${label}`, secret],
  );
  await run(
    env.DB,
    "INSERT INTO connections (id, org_id, connector_type, name, created_at, updated_at) VALUES (?, ?, 'webhook-push', 'Source', 1, 1)",
    [`conn-${label}`, orgId],
  );
  await run(
    env.DB,
    `INSERT INTO webhook_endpoints (id, org_id, mode, url, event_types, api_version, created_at, updated_at)
     VALUES (?, ?, 'live', 'https://example.test/hook', '["pass.created"]', 'v1', 1, 1)`,
    [`hook-${label}`, orgId],
  );
  await run(
    env.DB,
    `INSERT INTO webhook_endpoint_secrets (endpoint_id, org_id, mode, kek_version, iv, wrapped_dek, ciphertext, created_at)
     VALUES (?, ?, 'live', 1, ?, ?, ?, 1)`,
    [`hook-${label}`, orgId, blob, blob, blob],
  );
  await run(
    env.DB,
    "INSERT INTO bundles (id, org_id, name, token, created_at) VALUES (?, ?, 'Bundle', ?, 1)",
    [`bundle-${label}`, orgId, `h1:${label}`.padEnd(67, '0')],
  );
  await seedWaveTables(kit, {
    orgId,
    label,
    passId: live.id,
    scannerId: scanner.id,
  });
  await recordAudit(ctx, {
    orgId,
    actorType: 'system',
    actorId: null,
    action: 'org.update',
    targetType: 'org',
    targetId: orgId,
  });
  return {
    orgId,
    adminUserId: admin.userId,
    passes: [live.id, second.id, test.id],
    holderEmail,
    templateId: `tpl-${label}`,
  };
}
