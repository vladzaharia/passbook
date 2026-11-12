import { expect } from 'vitest';
import type { z } from 'zod';
import { persistTemplate } from '../../../../test/helpers/index.ts';
import type { ScanLookupResultSchema } from '../../../shared/contracts/scan-session.ts';
import { run } from '../../platform/db.ts';
import { ensureCredentialRefKeyset } from '../passes/credential-keyset.ts';
import { ICON_PNG } from '../passes/pass-test-fixtures.ts';
import { approveScanReleases, key, type ScanKit, setupScanKit } from './test-kit.ts';

export let kit: ScanKit;
export let templateId: string;
export async function setupLookupIdsFixture() {
  kit = await setupScanKit();
  await ensureCredentialRefKeyset(kit.env.DB, kit.env);
  const resolved = kit.registry.add({
    id: `tpl-${key()}`,
    orgId: kit.org.id,
    manifest: {
      ...kit.template.manifest,
      inputs: {
        type: 'object',
        properties: { memberName: { type: 'string' }, memberNo: { type: 'string' } },
      },
      bindings: kit.template.manifest.bindings,
      scan: {
        actions: [{ id: 'enter', label: 'Check in', kind: 'check_in' }],
        lookup: { input: 'memberNo' },
      },
    },
    passJson: {
      ...kit.template.passJson,
      barcodes: [
        { format: 'PKBarcodeFormatQR', message: 'opaque:qr:payload', messageEncoding: 'utf-8' },
      ],
    },
    assets: { 'icon.png': ICON_PNG },
  });
  await persistTemplate(kit.fx, resolved, { registry: kit.registry });
  await approveScanReleases(kit, resolved.id, { version: resolved.version });
  templateId = resolved.id;
}
export const search = async (q: string, headers = kit.admin()) => {
  const response = await kit.post(headers, '/lookup', {
    q,
    ...(headers.cookie?.includes('__Host-wallet_scan=')
      ? {}
      : { scope: { orgId: kit.org.id, timeZone: 'UTC' } }),
  });
  expect(response.status).toBe(200);
  return response.json() as Promise<z.infer<typeof ScanLookupResultSchema>>;
};

export async function roleRestrictedTemplate(name = 'Role restricted lookup') {
  const resolved = kit.registry.add({
    id: `tpl-${key()}`,
    orgId: kit.org.id,
    manifest: {
      ...kit.template.manifest,
      name,
      inputs: {
        type: 'object',
        properties: {
          memberName: { type: 'string', 'x-scan': 'desk' },
          memberNo: { type: 'string' },
          accessZone: { type: 'string', 'x-scan': 'manager' },
        },
      },
      display: { title: '{{memberName}}', subtitle: '{{accessZone}}' },
      scan: {
        actions: [{ id: 'enter', label: 'Check in', kind: 'check_in' }],
        lookup: { input: 'memberNo' },
      },
    },
    passJson: {
      ...kit.template.passJson,
      barcodes: [
        { format: 'PKBarcodeFormatQR', message: 'opaque:qr:payload', messageEncoding: 'utf-8' },
      ],
    },
    assets: { 'icon.png': ICON_PNG },
  });
  await persistTemplate(kit.fx, resolved, { registry: kit.registry });
  await approveScanReleases(kit, resolved.id, { version: resolved.version });
  return resolved.id;
}

/** Insert indexed copies cheaply so that the first search page can be entirely ineligible. */
export async function cloneLookupPasses(
  seedId: string,
  tag: string,
  namePrefix: string,
  count: number,
  quarantined = false,
) {
  const idPrefix = `${seedId}-${tag}-`;
  await run(
    kit.env.DB,
    `WITH RECURSIVE seq(n) AS (SELECT 0 UNION ALL SELECT n + 1 FROM seq WHERE n + 1 < ?)
     INSERT INTO passes (id, org_id, identity_id, serial, template_id, template_version,
       auth_token, download_token, web_service_url, personalization, display_title, external_id,
       object_key, modified_at, created_at, mode, test_data_quarantined, release_id, pending_pass_json)
     SELECT ? || printf('%02d', n), p.org_id, p.identity_id, p.serial || '-' || ? || '-' || n,
       p.template_id, p.template_version, p.auth_token, p.download_token || '-' || ? || '-' || n,
       p.web_service_url, json_set(p.personalization, '$.memberName', ? || printf('%02d', n)),
       ? || printf('%02d', n), p.external_id, p.object_key, p.modified_at, p.created_at, p.mode, ?, p.release_id,
       json_set(v.pass_json, '$.serialNumber', p.serial || '-' || ? || '-' || n)
     FROM passes p JOIN pass_versions v ON v.pass_id=p.id AND v.version=p.version
       CROSS JOIN seq WHERE p.id = ?`,
    [count, idPrefix, tag, tag, namePrefix, namePrefix, quarantined ? 1 : 0, tag, seedId],
  );
  return Array.from({ length: count }, (_, n) => `${idPrefix}${String(n).padStart(2, '0')}`);
}

/** Change durable state after a lookup query has taken a snapshot, before it is projected. */
export function afterLookupRead(
  real: D1Database,
  passId: string,
  change: () => Promise<void>,
  stage: 'candidate' | 'matches' = 'candidate',
) {
  const state = { fired: false };
  const wrappedStatements = new WeakMap<D1PreparedStatement, D1PreparedStatement>();
  const wrap = (statement: D1PreparedStatement): D1PreparedStatement => {
    const wrapped = new Proxy(statement, {
      get(target, prop) {
        if (prop === 'bind') return (...values: unknown[]) => wrap(target.bind(...values));
        if (stage === 'candidate' && prop === 'first')
          return async () => {
            const row = await target.first<{ id: string }>();
            if (!state.fired && row?.id === passId) {
              state.fired = true;
              await change();
            }
            return row;
          };
        if (stage === 'matches' && prop === 'all')
          return async () => {
            const result = await target.all<{ id: string }>();
            if (!state.fired && result.results.some((row) => row.id === passId)) {
              state.fired = true;
              await change();
            }
            return result;
          };
        const value = Reflect.get(target, prop, target);
        return typeof value === 'function' ? value.bind(target) : value;
      },
    });
    wrappedStatements.set(wrapped, statement);
    return wrapped;
  };
  const db = new Proxy(real, {
    get(target, prop) {
      if (prop === 'prepare')
        return (sql: string) => {
          const statement = target.prepare(sql);
          const match =
            stage === 'candidate'
              ? sql.includes('credential_keyset.commitment AS credential_keyset_commitment')
              : sql.includes('FROM passes p JOIN templates');
          return match ? wrap(statement) : statement;
        };
      if (prop === 'batch')
        return async (statements: D1PreparedStatement[]) => {
          const results = await target.batch(
            statements.map((statement) => wrappedStatements.get(statement) ?? statement),
          );
          if (
            !state.fired &&
            statements.some(
              (statement, index) =>
                wrappedStatements.has(statement) &&
                results[index]?.results?.some(
                  (row) =>
                    row !== null && typeof row === 'object' && 'id' in row && row.id === passId,
                ),
            )
          ) {
            state.fired = true;
            await change();
          }
          return results;
        };
      const value = Reflect.get(target, prop, target);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
  return { db, state };
}
