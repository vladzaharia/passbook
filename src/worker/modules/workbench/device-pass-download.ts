import { DEVICE_PASS_GONE_COPY } from '../../../shared/copy/workbench-device-pass.ts';
import { sha256Hex } from '../../platform/ids.ts';
import type { ServiceContext } from '../../platform/service-context.ts';
import { recordAudit } from '../audit/service.ts';
import { getPass } from '../passes/repo-read-pass.ts';
import { buildDevicePass } from './device-pass-build.ts';
import {
  consumeCode,
  endDevicePass,
  getDevicePass,
  markServed,
  releaseCode,
} from './repo-device-pass.ts';

const PAGE = `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1"><title>Link used</title>
<style>body{font:16px system-ui,sans-serif;margin:0;display:grid;place-items:center;min-height:100vh;padding:1rem;text-align:center}</style>
</head><body><p>${DEVICE_PASS_GONE_COPY}</p></body></html>`;

const NO_STORE = { 'cache-control': 'no-store', 'referrer-policy': 'no-referrer' } as const;

/** What a used, expired or unknown code answers: all the same 410, so a code cannot be probed. */
export const codeGone = (): Response =>
  new Response(PAGE, {
    status: 410,
    headers: { ...NO_STORE, 'content-type': 'text/html; charset=utf-8' },
  });

/**
 * `GET /d/{code}`: the one-time download. The code is spent by one statement, so of two requests with it
 * exactly one gets the pass. A build that fails after that gives the code back: the phone has nothing yet.
 */
export async function downloadByCode(ctx: ServiceContext, code: string): Promise<Response> {
  const db = ctx.env.DB;
  const id = await consumeCode(db, await sha256Hex(code), ctx.clock.now());
  if (!id) return codeGone();
  try {
    const row = await getDevicePass(db, id);
    const source = row ? await getPass(db, row.pass_id) : null;
    if (!row || !source) return codeGone();
    if (source.status !== 'active' || source.removedAt !== null || source.deletedAt !== null) {
      if (await endDevicePass(db, id, 'pass_gone', ctx.clock.now()))
        await recordAudit(ctx, {
          orgId: row.org_id,
          actorType: 'system',
          actorId: null,
          action: 'device_pass.voided',
          targetType: 'device_pass',
          targetId: id,
          detail: { reason: 'pass_gone' },
        });
      return codeGone();
    }
    const built = await buildDevicePass(ctx, row, source);
    await markServed(db, id, ctx.clock.now(), built.hash);
    await recordAudit(ctx, {
      orgId: row.org_id,
      actorType: 'device',
      actorId: null,
      action: 'device_pass.downloaded',
      targetType: 'device_pass',
      targetId: id,
      detail: {},
    });
    return new Response(built.bytes as BodyInit, {
      headers: {
        ...NO_STORE,
        'content-type': 'application/vnd.apple.pkpass',
        'content-disposition': 'inline; filename="test-pass.pkpass"',
        'x-content-type-options': 'nosniff',
      },
    });
  } catch (error) {
    await releaseCode(db, id, ctx.clock.now());
    throw error;
  }
}
