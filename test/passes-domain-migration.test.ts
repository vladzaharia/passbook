import { env } from 'cloudflare:workers';
import { describe, expect, it } from 'vitest';
import { first, run } from '../src/worker/platform/db.ts';
import { fixtures, makeEnv, makeOrg, makePass, makeTemplate } from './helpers/index.ts';

const move = env.TEST_MIGRATIONS.find((m) => m.name === '0007_passes.sql');

const urlOf = async (id: string) =>
  (
    await first<{ url: string }>(env.DB, 'SELECT web_service_url AS url FROM passes WHERE id = ?', [
      id,
    ])
  )?.url;

describe('0007_passes migration', () => {
  it('moves stored web service URLs off wallet.plrs.im and leaves others alone', async () => {
    expect(move?.queries.length).toBeGreaterThan(0);
    const f = fixtures(await makeEnv());
    const org = await makeOrg(f);
    const old = await makePass(f, {
      orgId: org.id,
      template: makeTemplate({ id: 't-old' }).resolved,
    });
    const dev = await makePass(f, {
      orgId: org.id,
      template: makeTemplate({ id: 't-dev' }).resolved,
    });
    const set = (id: string, url: string) =>
      run(env.DB, 'UPDATE passes SET web_service_url = ? WHERE id = ?', [url, id]);
    await set(old.id, 'https://wallet.plrs.im/wallet');
    await set(dev.id, 'http://localhost:5173/wallet');

    for (const query of move?.queries ?? []) await env.DB.prepare(query).run();

    expect(await urlOf(old.id)).toBe('https://passbook.mobile/wallet');
    expect(await urlOf(dev.id)).toBe('http://localhost:5173/wallet');
  });
});
