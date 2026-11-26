import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { firstDeploy, type Wrangler } from './binding-first-deploy.ts';

const KEY = 'test-key-not-real-0123456789';
const ENV = { CLOUDFLARE_API_TOKEN: 't', CLOUDFLARE_ACCOUNT_ID: 'a', POCKET_ID_API_KEY: KEY };
const CONFIG = 'workers/polaris-binding/wrangler.jsonc';
const ID = '11111111-2222-3333-4444-555555555555';

function setup(existing: boolean) {
  const root = mkdtempSync(join(tmpdir(), 'bfd-'));
  mkdirSync(join(root, 'workers/polaris-binding'), { recursive: true });
  writeFileSync(
    join(root, CONFIG),
    '{\n  "database_id": "00000000-0000-0000-0000-000000000000",\n  "other": 1\n}\n',
  );
  const calls: { args: string[]; stdin?: string }[] = [];
  let exists = existing;
  const wrangler: Wrangler = (args, stdin) => {
    calls.push({ args, stdin });
    if (args[1] === 'list')
      return {
        status: 0,
        stdout: JSON.stringify(exists ? [{ uuid: ID, name: 'polaris-binding' }] : []),
      };
    if (args[1] === 'create') exists = true;
    return { status: 0, stdout: '' };
  };
  const logs: string[] = [];
  const run = (env: Record<string, string | undefined> = ENV) =>
    firstDeploy({ root, env, wrangler, log: (l) => logs.push(l) });
  return { root, calls, logs, run };
}

describe('firstDeploy', () => {
  it('refuses without the profile vars and runs nothing', () => {
    const s = setup(true);
    expect(() => s.run({ ...ENV, POCKET_ID_API_KEY: undefined })).toThrow(/POCKET_ID_API_KEY/);
    expect(() => s.run({})).toThrow(/CLOUDFLARE_API_TOKEN/);
    expect(s.calls).toHaveLength(0);
  });

  it('creates the D1 when absent, writes its id and deploys', () => {
    const s = setup(false);
    s.run();
    const verbs = s.calls.map((c) => c.args.slice(0, 2).join(' '));
    expect(verbs).toEqual([
      'd1 list',
      'd1 create',
      'd1 list',
      'd1 migrations',
      'secret put',
      'deploy --config',
    ]);
    expect(readFileSync(join(s.root, CONFIG), 'utf8')).toContain(`"database_id": "${ID}"`);
    expect(readFileSync(join(s.root, CONFIG), 'utf8')).toContain('"other": 1');
  });

  it('reuses an existing D1 and is idempotent', () => {
    const s = setup(true);
    s.run();
    s.run();
    expect(s.calls.some((c) => c.args[1] === 'create')).toBe(false);
    expect(s.logs).toContain(`${CONFIG} already holds the D1 id`);
  });

  it('sends the key only on stdin, never in args or logs, and targets only the binding config', () => {
    const s = setup(true);
    s.run();
    expect(s.calls.filter((c) => c.stdin === KEY)).toHaveLength(1);
    for (const c of s.calls) {
      expect(c.args.join(' ')).not.toContain(KEY);
      if (c.args.includes('--config')) expect(c.args[c.args.indexOf('--config') + 1]).toBe(CONFIG);
    }
    expect(s.calls.filter((c) => c.args.includes('--remote'))).toHaveLength(1);
    expect(s.logs.join('\n')).not.toContain(KEY);
  });

  it('stops at the first failing step', () => {
    const s = setup(true);
    const bad: Wrangler = (args) => ({
      status: args[0] === 'secret' ? 1 : 0,
      stdout: '[{"uuid":"u","name":"polaris-binding"}]',
    });
    expect(() => firstDeploy({ root: s.root, env: ENV, wrangler: bad, log: () => {} })).toThrow(
      /Secret failed/,
    );
  });
});
