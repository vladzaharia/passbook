import { makeUser, persistTemplate } from '../../../../test/helpers/index.ts';
import { first, run } from '../../platform/db.ts';
import type { AppEnv } from '../../platform/env.ts';
import type { ServiceContext } from '../../platform/service-context.ts';
import { jobCtxOf } from '../delivery/delivery-test-fixtures.ts';
import { approveAppleRelease } from '../passes/apple-release-test-fixtures.ts';
import { createPassRow } from '../passes/create.ts';
import { credentialReferences } from '../passes/credential-references.ts';
import { depsOf, overrideDeps } from '../passes/deps.ts';
import { type Kit, setupKit, TINY_PNG } from '../passes/pass-test-fixtures.ts';

/** A waiting pass on a template whose barcode is the same static value for every holder. */
export async function fixedBarcodePass(options: { retired?: boolean } = {}) {
  const kit = await setupKit();
  const template = kit.registry.add({
    id: `fixed-${kit.fx.ids.id()}`,
    orgId: kit.org.id,
    version: 'v1',
    manifest: kit.template.manifest,
    passJson: {
      ...kit.template.passJson,
      barcodes: [
        {
          format: 'PKBarcodeFormatQR',
          message: 'fixed-holder-credential',
          messageEncoding: 'iso-8859-1',
        },
      ],
    },
    assets: { 'icon.png': TINY_PNG },
  });
  await persistTemplate(kit.fx, template, { registry: kit.registry });
  const release = await approveAppleRelease(kit, {
    templateId: template.id,
    version: template.version,
  });
  // Storage lasts for the whole file, so each case needs its own address.
  const email = `waiting-${kit.fx.ids.id()}@example.test`;
  const pass = await createPassRow(jobCtxOf(kit), {
    orgId: kit.org.id,
    templateId: template.id,
    templateVersion: release.version,
    releaseId: release.id,
    releaseGeneration: release.generation,
    mode: 'live',
    source: 'manual',
    execution: { kind: 'system' },
    actor: { type: 'system', id: null },
    input: { memberName: 'Waiting holder' },
    holderEmail: email,
  });
  const user = await makeUser(kit.fx, { primaryEmail: email });
  if (options.retired) await retireBarcode(kit, pass);
  return { kit, pass, user, email };
}

/** Records the static barcode as retired by an earlier pass: a retired credential never returns. */
async function retireBarcode(kit: Kit, pass: { id: string; orgId: string }) {
  const guard = await first<{ sql: string }>(
    kit.env.DB,
    "SELECT sql FROM sqlite_master WHERE name = 'pass_credential_tombstones_insert_guard'",
  );
  if (!guard) throw new Error('Missing tombstone guard');
  const refs = await credentialReferences(kit.env, pass.orgId, 'live', {
    barcodeMessage: 'fixed-holder-credential',
  });
  await run(kit.env.DB, 'DROP TRIGGER pass_credential_tombstones_insert_guard');
  try {
    for (const entry of refs)
      await run(
        kit.env.DB,
        `INSERT INTO pass_credential_tombstones
        (pass_id, org_id, mode, credential_generation, credential_kind, credential_hash, retired_at)
        VALUES (?, ?, 'live', 1, ?, ?, ?)`,
        [pass.id, pass.orgId, entry.kind, entry.ref, kit.clock.now()],
      );
  } finally {
    await run(kit.env.DB, guard.sql);
  }
}

/** Runs `change` just before the first batch that carries the link's owner write. */
export function atOwnerWrite(kit: Kit, change: () => Promise<unknown>) {
  let fired = false;
  const writes = new WeakSet<D1PreparedStatement>();
  const db = new Proxy(kit.env.DB, {
    get(target, prop) {
      if (prop === 'prepare')
        return (sql: string) => {
          const prepared = target.prepare(sql);
          if (!/^\s*UPDATE passes\b[\s\S]*\bowner_user_id\b/i.test(sql)) return prepared;
          return new Proxy(prepared, {
            get(statement, key) {
              if (key === 'bind')
                return (...values: unknown[]) => {
                  const bound = statement.bind(...values);
                  writes.add(bound);
                  return bound;
                };
              const value = Reflect.get(statement, key, statement);
              return typeof value === 'function' ? value.bind(statement) : value;
            },
          });
        };
      if (prop === 'batch')
        return async (statements: D1PreparedStatement[]) => {
          if (!fired && statements.some((statement) => writes.has(statement))) {
            fired = true;
            await change();
          }
          return target.batch(statements);
        };
      const value = Reflect.get(target, prop, target);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
  const env: AppEnv = { ...kit.env, DB: db };
  overrideDeps(env, depsOf(kit.env));
  return { ctx: { ...jobCtxOf(kit), env } as ServiceContext, fired: () => fired };
}
