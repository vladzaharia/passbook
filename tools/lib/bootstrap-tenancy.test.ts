import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { remoteCommands } from './bootstrap-tenancy.ts';

describe('bootstrap remote commands', () => {
  it('reads the snapshot with --command: a remote --file returns counts, not rows', () => {
    const [read] = remoteCommands('owner@example.com');
    expect(read).toBe(
      'npx wrangler d1 execute wallet-platform --remote --json --command "$(cat .wrangler/bootstrap-snapshot.sql)" > .wrangler/bootstrap-snapshot.json',
    );
  });

  it('are the commands the runbook gives', () => {
    const runbook = readFileSync(resolve(import.meta.dirname, '../../docs/operations.md'), 'utf8');
    for (const command of remoteCommands('<email>')) expect(runbook).toContain(command);
  });
});
