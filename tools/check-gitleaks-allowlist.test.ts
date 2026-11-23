import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const which = spawnSync('gitleaks', ['version']);
const script = resolve(import.meta.dirname, 'check-gitleaks-allowlist.ts');

// CI runs the same script against the pinned binary; locally the test needs `gitleaks` on the PATH.
describe('.gitleaks.toml allowlist', () => {
  it.skipIf(which.error)(
    'allows the demo shapes and reports a real token that contains one',
    () => {
      const run = spawnSync(process.execPath, [script], { encoding: 'utf8' });
      expect(run.stderr).toBe('');
      expect(run.status).toBe(0);
    },
  );
});
