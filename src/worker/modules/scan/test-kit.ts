import {
  type Fixtures,
  fakeAuth,
  fakeRateLimiter,
  makePass,
  makeScanEvent,
  makeScanner,
  makeScanStaff,
  makeUser,
  persistTemplate,
} from '../../../../test/helpers/index.ts';
import type { ResolvedTemplate } from '../../../passkit/template/registry.ts';
import type { PassJson, ScanManifest, TemplateManifest } from '../../../passkit/types.ts';
import type { OrgRole } from '../../../shared/contracts/org-membership.ts';
import { createApp } from '../../app.ts';
import { batch, first, run, stmt } from '../../platform/db.ts';
import { sha256Hex } from '../../platform/ids.ts';
import type { ServiceContext } from '../../platform/service-context.ts';
import { jobCtxOf } from '../delivery/delivery-test-fixtures.ts';
import { getHolderPass } from '../holders/repo.ts';
import {
  approveAppleRelease,
  prepareAppleReleaseVersion,
} from '../passes/apple-release-test-fixtures.ts';
import { createPassRow } from '../passes/create.ts';
import {
  captureCredentialKeyEnv,
  credentialRefKeysetCommitment,
  requireCredentialRefKeyset,
} from '../passes/credential-keyset.ts';
import {
  type CredentialTransferResult,
  startCredentialTransfer,
} from '../passes/credential-transfer.ts';
import { ICON_PNG, type Kit, setupKit } from '../passes/pass-test-fixtures.ts';
import type { Pass } from '../passes/repo.ts';
import { requireApprovedRelease } from '../templates/releases.ts';
import { type ScanActor, scanScannerCsrfProof } from './actor.ts';
import { createScannerStore } from './auth-store.ts';
import { cloneObservedScanActor } from './scanning-workspace-observation.ts';
import { captureTestEpochs } from './test-kit-epochs.ts';

export const ORIGIN = 'https://wallet.test';
const DAY = 86_400_000;

export interface ScanKit extends Kit {
  /** A template with `scan`, a QR bound to the scan code, and approved releases by default. */
  scanTemplate(
    name: string,
    scan: ScanManifest,
    options?: {
      orgId?: string;
      passStyle?: Record<string, unknown>;
      assets?: Record<string, Uint8Array>;
      releaseModes?: readonly ('live' | 'test')[];
    },
  ): Promise<string>;
  /** A real pass through the service (scan code, barcode hash and pass.json all written). */
  scanPass(
    templateId: string,
    input?: Record<string, unknown>,
    options?: { mode?: 'live' | 'test'; orgId?: string; holderEmail?: string },
  ): Promise<Pass>;
  scanner(options?: Partial<Parameters<typeof makeScanner>[1]>): ReturnType<typeof makeScanner>;
  staff: (role: 'door' | 'desk' | 'manager', name?: string) => ReturnType<typeof makeScanStaff>;
  event: (
    options: Partial<Parameters<typeof makeScanEvent>[1]>,
  ) => ReturnType<typeof makeScanEvent>;
  post(headers: Record<string, string>, path: string, body: unknown): Promise<Response>;
  get(headers: Record<string, string>, path: string): Promise<Response>;
  admin(): Record<string, string>;
}

let sequence = 0;

/** Capture scanner and credential-keyset authority without retaining the raw CSRF secret. */
export async function proofedScanActor(
  ctx: ServiceContext,
  actor: ScanActor,
  options: { keysetPolicy?: 'require' | 'defer'; epochs?: boolean } = {},
): Promise<ScanActor> {
  const scanner = actor.scanner;
  const scannerId = scanner?.id;
  const scannerSecret = scanner?.csrfSecret;
  const originalProof = actor.scannerCsrfProof;
  const keyEnv = captureCredentialKeyEnv(ctx.env);
  const proofed: ScanActor = {
    ...actor,
    credentialKeysetCommitment:
      options.keysetPolicy === 'defer'
        ? await credentialRefKeysetCommitment(keyEnv)
        : await requireCredentialRefKeyset(ctx.env.DB, keyEnv),
  };
  if (scannerId !== undefined)
    proofed.scannerCsrfProof =
      scannerSecret == null
        ? (originalProof ?? null)
        : await scanScannerCsrfProof(keyEnv, scannerId, scannerSecret);
  if (options.epochs !== false) await captureTestEpochs(ctx, proofed);
  return cloneObservedScanActor(proofed);
}

/** Give an existing user an explicit membership in one organization. */
export async function grantScanMembership(
  f: Fixtures,
  orgId: string,
  userId: string,
  roles: OrgRole[] = ['org_admin'],
): Promise<string> {
  const invitationId = f.ids.id();
  const membershipId = f.ids.id();
  const now = f.clock.now();
  const roleJson = JSON.stringify(roles);
  const tokenHash = await sha256Hex(f.ids.token());
  await batch(f.env.DB, [
    stmt(
      f.env.DB,
      `INSERT INTO org_invitations
        (id, org_id, email, roles, token_hash, created_at, expires_at, accepted_at)
       SELECT ?, ?, primary_email, ?, ?, ?, ?, ? FROM users WHERE id = ?`,
      [invitationId, orgId, roleJson, tokenHash, now, now + 60_000, now, userId],
    ),
    stmt(
      f.env.DB,
      `INSERT INTO org_memberships (id, org_id, user_id, invitation_id, roles, created_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
      [membershipId, orgId, userId, invitationId, roleJson, now],
    ),
  ]);
  return membershipId;
}

/** Start a real transfer against the current holder, optionally bypassing an intercepted D1. */
export async function startScanCredentialTransfer(
  kit: Pick<Kit, 'ctx'>,
  passId: string,
  options: { db?: D1Database; target?: { holderEmail: string; ownerUserId: string | null } } = {},
): Promise<CredentialTransferResult> {
  const db = options.db ?? kit.ctx.env.DB;
  const expected = await getHolderPass(db, passId, null);
  if (!expected) throw new Error('Missing holder transfer snapshot');
  const env = { ...kit.ctx.env, DB: db };
  return startCredentialTransfer(
    jobCtxOf({ ctx: { ...kit.ctx, env } }),
    { type: 'system', id: null },
    passId,
    options.target ?? { holderEmail: 'next-holder@example.test', ownerUserId: null },
    null,
    { kind: 'tenant-holder', expected },
  );
}

/** Insert a pre-release pass with a stored pinned Wallet snapshot. */
export async function makeLegacyScanPass(
  f: Fixtures,
  options: {
    orgId: string;
    template: ResolvedTemplate;
    mode?: 'live' | 'test';
    personalization?: object;
    holderEmail?: string;
  },
) {
  const pass = await makePass(f, {
    orgId: options.orgId,
    template: options.template,
    mode: options.mode,
    personalization: options.personalization,
    holderEmail: options.holderEmail,
  });
  await batch(f.env.DB, [
    stmt(
      f.env.DB,
      `UPDATE pass_versions SET pass_json = (
      SELECT json_set(?, '$.serialNumber', p.serial,
        '$.passTypeIdentifier', si.pass_type_identifier, '$.teamIdentifier', si.team_identifier)
      FROM passes p JOIN signing_identities si ON si.id = p.identity_id WHERE p.id = ?
    ) WHERE pass_id = ?`,
      [JSON.stringify(options.template.passJson), pass.id, pass.id],
    ),
  ]);
  return pass;
}

/** Publish scoped Apple heads, including a new generation when a head already exists. */
export async function approveScanReleases(
  kit: Kit,
  templateId: string,
  options: {
    orgId?: string;
    version?: string;
    modes?: readonly ('live' | 'test')[];
    db?: D1Database;
  } = {},
) {
  const version = options.version ?? (await kit.registry.resolve(templateId)).version;
  for (const mode of options.modes ?? ['live', 'test']) {
    await approveAppleRelease(kit, {
      templateId,
      orgId: options.orgId ?? kit.org.id,
      mode,
      version,
      db: options.db,
    });
  }
}

/** The passes kit plus a scan template factory, a real app with the scanner store, and fixtures. */
export async function setupScanKit(options: { clockStart?: number } = {}): Promise<ScanKit> {
  const kit = await setupKit(options);
  // Storage is per file, and kits are often built in beforeEach.
  const adminId = 'admin-1';
  if (!(await first(kit.env.DB, 'SELECT 1 FROM users WHERE id=?', [adminId])))
    await makeUser(kit.fx, { id: adminId });
  await grantScanMembership(kit.fx, kit.org.id, adminId);
  Object.assign(kit.env, {
    RL_SCAN: fakeRateLimiter({ limit: 100_000 }),
    RL_SCAN_ORG: fakeRateLimiter({ limit: 100_000 }),
    RL_SCAN_LOOKUP: fakeRateLimiter({ limit: 100_000 }),
    RL_SCAN_PAIR: fakeRateLimiter({ limit: 100_000 }),
  });
  const fake = fakeAuth(ORIGIN);
  fake.bindSessions(kit.env.DB, kit.clock);
  const app = createApp({
    stores: { ...fake.stores, scanners: createScannerStore(kit.env, kit.clock) },
    clock: kit.clock,
  });
  const json = (headers: Record<string, string>) => ({
    ...headers,
    'content-type': 'application/json',
  });
  const base = kit.template;
  return {
    ...kit,
    async scanTemplate(name, scan, options = {}) {
      const id = `tpl-${(sequence++).toString(36)}-${kit.fx.ids.token(3)}`;
      const manifest: TemplateManifest = {
        ...base.manifest,
        name,
        inputs: {
          type: 'object',
          required: ['memberName'],
          properties: {
            memberName: { type: 'string', minLength: 1 },
            memberNo: { type: 'string' },
            startsAt: { type: 'string', format: 'date-time' },
            endsAt: { type: 'string', format: 'date-time' },
            tier: { type: 'string' },
            balance: { type: 'integer', minimum: 0 },
          },
        },
        bindings: [
          ...base.manifest.bindings,
          { to: { barcode: 0, prop: 'message' }, value: '{{pass.scanCode}}' },
        ],
        scan,
      };
      const resolved = kit.registry.add({
        id,
        orgId: options.orgId ?? kit.org.id,
        manifest,
        passJson: {
          ...base.passJson,
          barcodes: [{ format: 'PKBarcodeFormatQR', message: 'x', messageEncoding: 'utf-8' }],
          ...(options.passStyle ?? {}),
        } as PassJson,
        assets: { 'icon.png': ICON_PNG, ...options.assets },
      });
      await persistTemplate(kit.fx, resolved, { registry: kit.registry });
      if (options.releaseModes?.length === 0)
        await prepareAppleReleaseVersion(kit, { templateId: id, version: resolved.version });
      await approveScanReleases(kit, id, {
        orgId: resolved.orgId ?? kit.org.id,
        version: resolved.version,
        modes: options.releaseModes,
      });
      return id;
    },
    async scanPass(templateId, input = {}, options = {}) {
      const orgId = options.orgId ?? kit.org.id;
      const mode = options.mode ?? 'live';
      const release = await requireApprovedRelease(kit.ctx, templateId, orgId, mode, 'apple');
      return createPassRow(jobCtxOf(kit), {
        orgId,
        templateId,
        templateVersion: release.version,
        releaseId: release.id,
        releaseGeneration: release.generation,
        input: { memberName: 'Anna Popescu', ...input } as never,
        holderEmail: options.holderEmail ?? null,
        mode,
        source: 'manual',
        actor: { type: 'system', id: null },
        execution: { kind: 'system' },
      });
    },
    scanner: (options = {}) => makeScanner(kit.fx, { orgId: kit.org.id, ...options }),
    staff: (role, name) =>
      makeScanStaff(kit.fx, { orgId: kit.org.id, role, ...(name ? { name } : {}) }),
    event: (options) => makeScanEvent(kit.fx, { orgId: kit.org.id, ...options }),
    post: (headers, path, body) =>
      Promise.resolve(
        app.request(
          `${ORIGIN}/api/v1/scan${path}`,
          { method: 'POST', headers: json(headers), body: JSON.stringify(body) },
          kit.env,
        ),
      ),
    get: (headers, path) =>
      Promise.resolve(app.request(`${ORIGIN}/api/v1/scan${path}`, { headers }, kit.env)),
    admin: () => fake.admin(),
  };
}

/** A UUIDv7-shaped idempotency key that is unique per call. */
export function key(): string {
  const hex = (n: number) =>
    Array.from({ length: n }, () => Math.floor(Math.random() * 16).toString(16)).join('');
  return `${hex(8)}-${hex(4)}-7${hex(3)}-a${hex(3)}-${hex(12)}`;
}

export const codeOf = (pass: Pass) => ({ code: pass.scanCode ?? '', method: 'camera' as const });

/** Sets a column the service would not let a test reach, for staging a state. */
export const setPass = (kit: Kit, id: string, set: string, params: (string | number | null)[]) =>
  run(kit.env.DB, `UPDATE passes SET ${set} WHERE id = ?`, [...params, id]);

export { DAY };
