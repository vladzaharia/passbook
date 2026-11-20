import { expect } from 'vitest';
import { linkToken, persistTemplate } from '../../../../test/helpers/index.ts';
import { EVENT_MANIFEST, EVENT_PASS } from '../../../passkit/template/paper-fixtures.ts';
import type { PassJson, TemplateManifest } from '../../../passkit/types.ts';
import { run } from '../../platform/db.ts';
import { jobCtxOf } from '../delivery/delivery-test-fixtures.ts';
import { ruleKit } from '../message-rules/test-kit.ts';
import { approveAppleRelease } from '../passes/apple-release-test-fixtures.ts';
import { createPassRow } from '../passes/create.ts';
import { TINY_PNG } from '../passes/pass-test-fixtures.ts';
import { clearSettingsCache } from '../settings/service.ts';

export const ORIGIN = 'https://wallet.test';
export const json = { 'content-type': 'application/json' };

/** The words an event ticket must never carry on paper (the wallet barcode message, the scan code, the serial). */
export const FORBIDDEN = 'SECRET-SCAN-CODE';

/** A rule kit with printing on, and helpers for event-ticket passes with paper on. */
export async function pdfKit() {
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
  const printPass = async (paper?: unknown, holderEmail = 'holder@example.com') => {
    const resolved = kit.registry.add({
      id: `tpl-pdf-${kit.fx.ids.token(4)}`,
      version: 'v1',
      manifest: {
        ...EVENT_MANIFEST,
        ...(paper === undefined ? {} : { paper }),
      } as TemplateManifest,
      passJson: EVENT_PASS as PassJson,
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
      holderEmail,
      source: 'manual',
      mode: 'live',
      execution: { kind: 'system' },
      actor: { type: 'system', id: null },
    });
    const res = await api('PUT', `/passes/${pass.id}/channels`, { channels: { paper: 'on' } });
    expect(res.status).toBe(200);
    return pass;
  };
  const mint = async (passId: string) =>
    (await (await api('POST', `/passes/${passId}/prints`)).json()) as { id: string; code: string };
  const staffPdf = (passId: string, headers = kit.auth.admin()) =>
    kit.api(`/passes/${passId}/print/pdf`, { headers });
  const tokenOf = (pass: { downloadToken: string }) => linkToken(kit.env, pass as never);
  const holderPdf = async (pass: { downloadToken: string }, token?: string) =>
    kit.app.request(`${ORIGIN}/p/${token ?? (await tokenOf(pass))}/print/pdf`, {}, kit.env);
  return { kit, api, printPass, mint, staffPdf, holderPdf, tokenOf };
}

export { pdfText } from './pdf-read.ts';
