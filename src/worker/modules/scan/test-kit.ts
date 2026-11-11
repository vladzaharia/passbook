import {
  fakeAuth,
  fakeRateLimiter,
  makeScanEvent,
  makeScanner,
  makeScanStaff,
  persistTemplate,
} from '../../../../test/helpers/index.ts';
import type { PassJson, ScanManifest, TemplateManifest } from '../../../passkit/types.ts';
import { createApp } from '../../app.ts';
import { run } from '../../platform/db.ts';
import { createPassRow } from '../passes/create.ts';
import type { Pass } from '../passes/repo.ts';
import { ICON_PNG, type Kit, setupKit } from '../passes/test-kit.ts';
import { createScannerStore } from './auth-store.ts';

export const ORIGIN = 'https://wallet.test';
const DAY = 86_400_000;

export interface ScanKit extends Kit {
  /** A template with `scan` and a QR bound to the scan code; returns its id. */
  scanTemplate(
    name: string,
    scan: ScanManifest,
    options?: { orgId?: string; passStyle?: Record<string, unknown> },
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

/** The passes kit plus a scan template factory, a real app with the scanner store, and fixtures. */
export async function setupScanKit(): Promise<ScanKit> {
  const kit = await setupKit();
  Object.assign(kit.env, {
    RL_SCAN: fakeRateLimiter({ limit: 100_000 }),
    RL_SCAN_ORG: fakeRateLimiter({ limit: 100_000 }),
    RL_SCAN_LOOKUP: fakeRateLimiter({ limit: 100_000 }),
  });
  const fake = fakeAuth(ORIGIN);
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
          barcodes: [{ format: 'PKBarcodeFormatQR', message: 'x', messageEncoding: 'iso-8859-1' }],
          ...(options.passStyle ?? {}),
        } as PassJson,
        assets: { 'icon.png': ICON_PNG },
      });
      await persistTemplate(kit.fx, resolved);
      return id;
    },
    async scanPass(templateId, input = {}, options = {}) {
      return createPassRow(kit.ctx, {
        orgId: options.orgId ?? kit.org.id,
        templateId,
        templateVersion: (await kit.registry.resolve(templateId)).version,
        input: { memberName: 'Anna Popescu', ...input } as never,
        holderEmail: options.holderEmail ?? null,
        mode: options.mode ?? 'live',
        source: 'manual',
        actor: { type: 'system', id: null },
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
