import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  type BootstrapSnapshot,
  buildBootstrap,
  remoteCommands,
  type SnapshotPass,
} from './bootstrap-tenancy.ts';

describe('bootstrap remote commands', () => {
  it('reads the snapshot with --command (a remote --file returns counts, not rows), owner-only', () => {
    const [read, , apply] = remoteCommands('owner@example.com');
    expect(read).toBe(
      '(umask 077; npx wrangler d1 execute wallet-platform --remote --json --command "$(cat .wrangler/bootstrap-snapshot.sql)" > .wrangler/bootstrap-snapshot.json)',
    );
    expect(apply).toBe(
      'npx wrangler d1 execute wallet-platform --remote --file .wrangler/bootstrap-tenancy.sql; rm -f .wrangler/bootstrap-tenancy.sql',
    );
  });

  it('are the commands the runbook gives', () => {
    const runbook = readFileSync(resolve(import.meta.dirname, '../../docs/operations.md'), 'utf8');
    for (const command of remoteCommands('<email>')) expect(runbook).toContain(command);
  });
});

const pass = (over: Partial<SnapshotPass> = {}): SnapshotPass => ({
  id: 'p1',
  org_id: 'o1',
  mode: 'live',
  test_data_quarantined: 0,
  holder_email: 'holder@example.com',
  owner_user_id: null,
  version: 1,
  identity_id: 'platform',
  credential_generation: 1,
  lifecycle_generation: 0,
  template_id: 't1',
  template_version: 'v1',
  release_id: null,
  web_service_url: 'https://wallet.example/v1',
  link_generation: 1,
  object_key: 'passes/p1/1.pkpass',
  download_token: 'raw-download-token',
  status: 'active',
  removed_at: null,
  ...over,
});

const snapshot = (p: SnapshotPass): BootstrapSnapshot => ({
  owner: { id: 'u1', primary_email: 'owner@example.com' },
  orgs: [],
  templates: [],
  emails: [{ outbox_id: 'm1', to: 'holder@example.com', attach: 0, pass: p }],
  bundleEmails: [
    {
      outbox_id: 'b1',
      outbox_pass_id: p.id,
      to: 'holder@example.com',
      bundle: {
        id: 'bundle-1',
        org_id: 'o1',
        mode: 'live',
        name: 'Pair',
        token: 'raw-bundle-token',
        token_rotated_at: null,
        holder_email: 'holder@example.com',
      },
      members: [{ position: 0, pass: p }],
    },
  ],
});

describe('buildBootstrap', () => {
  it('writes token hashes and generation fences, never a raw download or bundle token', async () => {
    const { sql } = await buildBootstrap(snapshot(pass()), 'owner@example.com', 1_000);
    expect(sql).not.toContain('raw-download-token');
    expect(sql).not.toContain('raw-bundle-token');
    expect(sql).toContain('p.link_generation = 1');
    expect(sql).toContain('b.token_rotated_at IS NULL');
  });

  it('refuses a snapshot number that is not a safe integer', async () => {
    for (const bad of ['1 OR 1=1', 1.5, Number.MAX_SAFE_INTEGER + 1, null])
      await expect(
        buildBootstrap(
          snapshot(pass({ link_generation: bad as number })),
          'owner@example.com',
          1_000,
        ),
      ).rejects.toThrow('is not an integer');
    const s = snapshot(pass());
    const rotated = s.bundleEmails?.[0];
    if (rotated) rotated.bundle.token_rotated_at = '0) OR (1' as unknown as number;
    await expect(buildBootstrap(s, 'owner@example.com', 1_000)).rejects.toThrow(
      'is not an integer',
    );
  });
});
