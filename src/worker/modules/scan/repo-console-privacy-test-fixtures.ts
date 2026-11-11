import type { ScannerFixture } from '../../../../test/helpers/index.ts';
import type { ResolvedTemplate } from '../../../passkit/template/registry.ts';
import type { Mode } from '../../../shared/contracts/common.ts';
import { first, run } from '../../platform/db.ts';
import type { ScanKit } from './test-kit.ts';

export async function insertPrivacyTemplate(kit: ScanKit, template: ResolvedTemplate) {
  await run(
    kit.env.DB,
    `INSERT INTO templates (id, org_id, slug, name, origin, active_version, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      template.id,
      kit.org.id,
      template.id,
      template.manifest.name,
      template.origin,
      template.version,
      kit.clock.now(),
      kit.clock.now(),
    ],
  );
}

export async function insertPrivacyTemplateVersion(
  kit: ScanKit,
  template: ResolvedTemplate,
  assets: ResolvedTemplate['assets'],
  buildKey: string,
) {
  await run(
    kit.env.DB,
    `INSERT INTO template_versions (template_id, version, manifest, pass_json, assets, build_key, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
    [
      template.id,
      template.version,
      JSON.stringify(template.manifest),
      JSON.stringify(template.passJson),
      JSON.stringify(assets),
      buildKey,
      kit.clock.now(),
    ],
  );
}

export async function setPrivacyPassDetails(
  kit: ScanKit,
  passId: string,
  externalId: string,
  displayTitle: string,
) {
  await run(kit.env.DB, 'UPDATE passes SET external_id = ?, display_title = ? WHERE id = ?', [
    externalId,
    displayTitle,
    passId,
  ]);
}

export interface SeedScan {
  scanner: ScannerFixture;
  passId: string | null;
  orgId?: string;
  mode?: Mode;
  templateId?: string | null;
  actionId?: string | null;
  actionKind?: 'check_in' | 'set' | 'add' | 'take' | null;
  amount?: number;
  passVersion?: number;
  before?: string | number;
  after?: string | number;
}

export async function insertSeedScan(
  kit: ScanKit,
  templateId: string,
  options: SeedScan,
  id: string,
  at: number,
) {
  const passless = options.passId === null;
  await run(
    kit.env.DB,
    `INSERT INTO scans
      (id, org_id, mode, pass_id, template_id, scanner_id, actor_type, actor_id, actor_key,
       idempotency_key, request_hash, method, state, outcome, reason, action_id, action_kind,
       amount, pass_version, before_value, after_value, at)
     VALUES (?, ?, ?, ?, ?, ?, 'scanner', ?, ?, ?, 'seeded', 'camera', 'done', ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      id,
      options.orgId ?? kit.org.id,
      options.mode ?? 'live',
      options.passId,
      options.templateId === undefined ? (passless ? null : templateId) : options.templateId,
      options.scanner.id,
      options.scanner.id,
      `s:${options.scanner.id}`,
      `seed:${id}`,
      passless ? 'refused' : 'ok',
      passless ? 'not_found' : null,
      options.actionId === undefined ? (passless ? null : 'check_in') : options.actionId,
      options.actionKind === undefined ? (passless ? null : 'check_in') : options.actionKind,
      options.amount ?? null,
      options.passVersion ?? null,
      options.before === undefined ? null : JSON.stringify(options.before),
      options.after === undefined ? null : JSON.stringify(options.after),
      at,
    ],
  );
}

export function lastExportAudit(kit: ScanKit) {
  return first<{ org_id: string; detail: string }>(
    kit.env.DB,
    "SELECT org_id, detail FROM audit_log WHERE action = 'scan.export' ORDER BY id DESC LIMIT 1",
  );
}

export function findScanClaim(kit: ScanKit, scanner: ScannerFixture, idempotencyKey: string) {
  return first<{ n: number }>(
    kit.env.DB,
    'SELECT count(*) AS n FROM scans WHERE actor_key = ? AND idempotency_key = ?',
    [`s:${scanner.id}`, idempotencyKey],
  );
}
