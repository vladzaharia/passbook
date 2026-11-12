import { beforeEach } from 'vitest';
import { isolatedKeysetDatabase } from '../../../../test/helpers/credential-keyset.ts';
import { stagePendingCredentialTransfer } from '../../../../test/helpers/credential-transfer.ts';
import { persistTemplate } from '../../../../test/helpers/index.ts';
import { putMemberPhoto } from '../passes/member-photo.ts';
import { ICON_PNG, withKitDatabase } from '../passes/pass-test-fixtures.ts';
import type { Pass } from '../passes/repo.ts';
import { makePng } from '../templates/package/fixtures.ts';
import { scannerActor, withRole } from './actor.ts';
import { getScanner } from './repo-device.ts';
import { insertRetiredLookupRef, setPhotoGroup } from './repo-lookup-output-test-fixtures.ts';
import { readScannerScope } from './repo-scope.ts';
import {
  approveScanReleases,
  key,
  proofedScanActor,
  type ScanKit,
  setupScanKit,
} from './test-kit.ts';

export let kit: ScanKit;
export let templateId: string;
const png = btoa(String.fromCharCode(...makePng(270, 270)));

const lookupTemplate = () =>
  kit.scanTemplate('Lookup photos', {
    actions: [{ id: 'enter', label: 'Check in', kind: 'check_in' }],
    display: { v: 1, header: {}, photo: { minRole: 'door' } },
  });

export function registerLookupOutputFixture() {
  beforeEach(async () => {
    kit = await setupScanKit();
    templateId = await lookupTemplate();
  });
}

/** Storage is shared by the file and the keyset is a singleton: start from a database without one. */
export async function useKeysetlessDatabase() {
  kit = await withKitDatabase(await isolatedKeysetDatabase(), setupScanKit);
  templateId = await lookupTemplate();
}

export async function setupPhoto() {
  const pass = await kit.scanPass(
    templateId,
    { memberName: 'Lookup member' },
    { holderEmail: 'hidden@example.test' },
  );
  await setPhotoGroup(kit.env.DB, pass.id, 'lookup-photo-group');
  await putMemberPhoto(
    kit.ctx,
    { type: 'system', id: null },
    pass.id,
    { png, includeInPass: false },
    null,
  );
  return pass;
}

export async function scannerForLookup() {
  const scanner = await kit.scanner({ templateIds: [templateId] });
  const row = await getScanner(kit.env.DB, scanner.id);
  if (!row) throw new Error('Missing scanner fixture');
  const scope = await readScannerScope(kit.env.DB, row, null);
  const actor = await proofedScanActor(
    kit.ctx,
    withRole(scannerActor(kit.ctx, row, row.mode, 'cookie', scope), null),
    { keysetPolicy: 'defer' },
  );
  return { scanner, actor };
}

export async function hiddenLookupFixture() {
  const resolved = kit.registry.add({
    id: `hidden-${key()}`,
    orgId: kit.org.id,
    manifest: {
      ...kit.template.manifest,
      inputs: {
        type: 'object',
        properties: {
          memberName: { type: 'string', 'x-scan': 'desk' },
          memberNo: { type: 'string' },
        },
      },
      display: { title: '{{memberName}}' },
      scan: { actions: [{ id: 'enter', label: 'Check in', kind: 'check_in' }] },
    },
    passJson: kit.template.passJson,
    assets: { 'icon.png': ICON_PNG },
  });
  await persistTemplate(kit.fx, resolved, { registry: kit.registry });
  await approveScanReleases(kit, resolved.id, { version: resolved.version });
  templateId = resolved.id;
  const pass = await kit.scanPass(templateId, { memberName: 'Hidden Lookup Member' });
  const { actor } = await scannerForLookup();
  return { pass, actor };
}

export async function retireRef(pass: Pass, ref: string) {
  const id = kit.fx.ids.id();
  await stagePendingCredentialTransfer(kit.env.DB, pass.id, {
    id,
    token: kit.fx.ids.token(),
    now: kit.clock.now(),
    targetHolderEmail: 'next@example.test',
  });
  await insertRetiredLookupRef(kit.env.DB, id, ref, kit.clock.now());
}

export const resolveRequest = (code: string) => ({
  idempotencyKey: key(),
  input: { code, method: 'camera' as const },
  clientTs: kit.clock.now(),
});

export function interceptBatches(
  real: D1Database,
  before?: (sql: readonly string[]) => Promise<void>,
) {
  const batches: string[][] = [];
  const bindings: { sql: string; values: unknown[] }[] = [];
  const texts = new WeakMap<D1PreparedStatement, string>();
  const originals = new WeakMap<D1PreparedStatement, D1PreparedStatement>();
  const wrap = (statement: D1PreparedStatement, sql: string): D1PreparedStatement => {
    const proxy = new Proxy(statement, {
      get(target, property) {
        if (property === 'bind')
          return (...args: unknown[]) => {
            bindings.push({ sql, values: args });
            return wrap(target.bind(...args), sql);
          };
        const value = Reflect.get(target, property, target);
        return typeof value === 'function' ? value.bind(target) : value;
      },
    });
    texts.set(proxy, sql);
    originals.set(proxy, statement);
    return proxy;
  };
  const db = new Proxy(real, {
    get(target, property) {
      if (property === 'prepare') return (sql: string) => wrap(target.prepare(sql), sql);
      if (property === 'batch')
        return async (statements: D1PreparedStatement[]) => {
          const sql = statements.map((statement) => texts.get(statement) ?? '');
          batches.push(sql);
          if (before) await before(sql);
          return target.batch(statements.map((statement) => originals.get(statement) ?? statement));
        };
      const value = Reflect.get(target, property, target);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
  return { db, batches, bindings };
}
