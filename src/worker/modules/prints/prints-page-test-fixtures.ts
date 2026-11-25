import { expect } from 'vitest';
import { linkToken, persistTemplate } from '../../../../test/helpers/index.ts';
import { EVENT_MANIFEST, EVENT_PASS } from '../../../passkit/template/paper-fixtures.ts';
import type { PassJson, TemplateManifest } from '../../../passkit/types.ts';
import { all, run } from '../../platform/db.ts';
import { jobCtxOf } from '../delivery/delivery-test-fixtures.ts';
import { ruleKit } from '../message-rules/test-kit.ts';
import { approveAppleRelease } from '../passes/apple-release-test-fixtures.ts';
import { createPassRow } from '../passes/create.ts';
import { TINY_PNG } from '../passes/pass-test-fixtures.ts';
import { clearSettingsCache } from '../settings/service.ts';

export const json = { 'content-type': 'application/json' };
export const ORIGIN = 'https://wallet.test';
export const CODE = /P[A-Z2-7]{26}/;
export const GROUPED = /P[A-Z2-7]{8} [A-Z2-7]{9} [A-Z2-7]{9}/;

export async function setup() {
  const kit = await ruleKit();
  await run(
    kit.env.DB,
    "INSERT OR REPLACE INTO settings (scope, key, value, updated_by, updated_at) VALUES ('platform', 'print.enabled', 'true', 'test', 1)",
  );
  clearSettingsCache(kit.env.DB);
  const api = (method: string, path: string, body?: unknown, headers = kit.auth.admin()) =>
    kit.api(path, {
      method,
      headers: { ...headers, ...json },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  /** A pass of an event-ticket template with this `paper` block (none: the derived layout). */
  const withPaper = async (
    paper?: unknown,
    over: { manifest?: Partial<TemplateManifest>; passJson?: PassJson } = {},
  ) => {
    const resolved = kit.registry.add({
      id: `tpl-paper-${kit.fx.ids.token(4)}`,
      version: 'v1',
      manifest: {
        ...EVENT_MANIFEST,
        ...over.manifest,
        ...(paper === undefined ? {} : { paper }),
      } as TemplateManifest,
      passJson: over.passJson ?? (EVENT_PASS as PassJson),
      assets: { 'icon.png': TINY_PNG },
    });
    await persistTemplate(kit.fx, resolved, { registry: kit.registry });
    const release = await approveAppleRelease(kit, {
      templateId: resolved.id,
      version: (await kit.registry.resolve(resolved.id)).version,
      orgId: kit.org.id,
      mode: 'live',
    });
    const pass = await createPassRow(jobCtxOf(kit), {
      orgId: kit.org.id,
      templateId: resolved.id,
      templateVersion: release.version,
      releaseId: release.id,
      releaseGeneration: release.generation,
      input: { name: 'Ada', ticketNo: 'T-77' },
      holderEmail: 'holder@example.com',
      source: 'manual',
      mode: 'live',
      execution: { kind: 'system' },
      actor: { type: 'system', id: null },
    });
    const res = await api('PUT', `/passes/${pass.id}/channels`, { channels: { paper: 'on' } });
    expect(res.status).toBe(200);
    return pass;
  };
  const token = (pass: { downloadToken: string }) => linkToken(kit.env, pass as never);
  const holder = (t: string, method = 'GET', path = '') =>
    kit.app.request(
      `${ORIGIN}/p/${t}/print${path}`,
      { method, headers: { origin: ORIGIN } },
      kit.env,
    );
  const count = async (passId: string) =>
    (await all(kit.env.DB, 'SELECT 1 FROM pass_prints WHERE pass_id = ?', [passId])).length;
  return { kit, api, withPaper, token, holder, count };
}
