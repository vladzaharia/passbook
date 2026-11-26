import { mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { build, type Rolldown } from 'vite';
import { describe, expect, it } from 'vitest';
import {
  E2E_RELEASE_MARKERS,
  E2E_RELEASE_SQL,
  e2eReleaseDefine,
  e2eReleaseMismatch,
  e2eReleaseOn,
  e2eReleaseProblems,
} from './e2e-release.ts';

const root = resolve(import.meta.dirname, '../..');
const MODULE = resolve(root, 'src/worker/modules/wallet-providers/e2e-release.ts');

describe('e2e release build switch', () => {
  it('is on only for an e2e server run that asked for the release', () => {
    expect(e2eReleaseOn({ WALLET_E2E: '1', WALLET_E2E_RELEASE: '1' })).toBe(true);
    for (const env of [
      {},
      { WALLET_E2E: '1' },
      { WALLET_E2E_RELEASE: '1' },
      { WALLET_E2E: '1', WALLET_E2E_RELEASE: 'true' },
      { WALLET_E2E: 'true', WALLET_E2E_RELEASE: '1' },
      { CI: 'true', WALLET_E2E_PREVIEW: '1' },
    ])
      expect(e2eReleaseOn(env), JSON.stringify(env)).toBe(false);
    expect(e2eReleaseDefine({})).toEqual({ __WALLET_E2E_RELEASE__: 'false' });
  });

  it('releases through the table the migrations create, every row at once', () => {
    const migrations = readdirSync(join(root, 'migrations'))
      .filter((name) => name.endsWith('.sql'))
      .map((name) => readFileSync(join(root, 'migrations', name), 'utf8'))
      .join('\n');
    expect(migrations).toMatch(/CREATE TABLE wallet_provider_releases \(/);
    expect(E2E_RELEASE_SQL).toBe(
      "UPDATE wallet_provider_releases SET state = 'released', changed_at = 0;",
    );
  });

  it('marks strings the Worker module really carries', () => {
    const source = readFileSync(MODULE, 'utf8');
    for (const marker of E2E_RELEASE_MARKERS) expect(source).toContain(`'${marker}'`);
  });
});

describe('e2e server check', () => {
  const open = { google: true, samsung: true };
  const dark = { google: false, samsung: false };

  it('lets the main run use only a dark server, and the wallets run only an open one', () => {
    expect(e2eReleaseMismatch(dark, false)).toBeNull();
    expect(e2eReleaseMismatch(open, true)).toBeNull();
    expect(e2eReleaseMismatch(open, false)).toMatch(/open on this server/);
    expect(e2eReleaseMismatch(dark, true)).toMatch(/test:e2e:wallets/);
  });

  it('refuses a half-open or unread setting either way', () => {
    for (const released of [undefined, {}, { google: true, samsung: false }, { google: 'true' }])
      for (const wantOpen of [true, false])
        expect(e2eReleaseMismatch(released, wantOpen), JSON.stringify(released)).not.toBeNull();
  });
});

describe('Worker bundle scan', () => {
  const dist = (files: Record<string, string>) => {
    const dir = mkdtempSync(join(tmpdir(), 'e2e-release-'));
    for (const [name, text] of Object.entries(files)) {
      mkdirSync(join(dir, name, '..'), { recursive: true });
      writeFileSync(join(dir, name), text);
    }
    return dir;
  };

  it('passes a Worker without the release', () => {
    expect(
      e2eReleaseProblems(dist({ 'index.js': 'export default {}', 'wrangler.json': '{}' })),
    ).toEqual([]);
  });

  it('flags a script or config that carries a marker', () => {
    const dir = dist({
      'index.js': 'ok',
      'assets/chunk.js': 'e.WALLET_E2E_RELEASE',
      'wrangler.json': '{"vars":{"WALLET_E2E_RELEASE":""}}',
    });
    expect(e2eReleaseProblems(dir).sort()).toEqual([
      'assets/chunk.js contains WALLET_E2E_RELEASE (the e2e provider release)',
      'wrangler.json contains WALLET_E2E_RELEASE (the e2e provider release)',
    ]);
  });

  it('refuses to vouch for a missing or empty Worker', () => {
    expect(e2eReleaseProblems(join(tmpdir(), 'no-such-dist'))[0]).toMatch(/does not exist/);
    expect(e2eReleaseProblems(dist({ 'wrangler.json': '{}' }))[0]).toMatch(/no Worker script/);
  });
});

/** Bundles the Worker's own call (`openE2eRelease()`, as src/worker/index.ts makes it) the way the build does. */
async function bundle(env: Record<string, string>): Promise<string> {
  const dir = mkdtempSync(join(tmpdir(), 'e2e-release-entry-'));
  const entry = join(dir, 'entry.ts');
  writeFileSync(entry, `import { openE2eRelease } from '${MODULE}';\nopenE2eRelease();\n`);
  const result = (await build({
    configFile: false,
    root,
    logLevel: 'silent',
    define: e2eReleaseDefine(env),
    build: {
      ssr: entry,
      write: false,
      minify: true,
      rolldownOptions: { external: [/^cloudflare:/] },
    },
  })) as Rolldown.RolldownOutput | Rolldown.RolldownOutput[];
  return (Array.isArray(result) ? result : [result])
    .flatMap((out) => out.output)
    .map((chunk) => ('code' in chunk ? chunk.code : ''))
    .join('\n');
}

describe('production build', () => {
  it('drops the e2e release path; an e2e release build keeps it', async () => {
    const production = await bundle({});
    for (const marker of E2E_RELEASE_MARKERS) expect(production).not.toContain(marker);
    const e2e = await bundle({ WALLET_E2E: '1', WALLET_E2E_RELEASE: '1' });
    for (const marker of E2E_RELEASE_MARKERS) expect(e2e).toContain(marker);
  }, 120_000);
});
