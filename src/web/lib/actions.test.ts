import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { ACTIONS, actionOf } from './actions.ts';

const WORKER = join(process.cwd(), 'src/worker');
const sources = (dir: string): string[] =>
  readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return sources(path);
    return name.endsWith('.ts') && !name.includes('.test.') ? [path] : [];
  });

/** Every audit action the Worker writes: `action: '...'` fields and `audit(ctx, ..., '...')` calls. */
function workerActions(): Map<string, string> {
  const found = new Map<string, string>();
  for (const file of sources(WORKER)) {
    for (const line of readFileSync(file, 'utf8').split('\n')) {
      if (!/\baction:|\baudit\(ctx/.test(line)) continue;
      for (const [, code] of line.matchAll(/'([a-z_]+\.[a-z_.]+)'/g))
        if (code) found.set(code, file.replace(`${process.cwd()}/`, ''));
    }
  }
  return found;
}

describe('audit action vocabulary', () => {
  it('has a label, glyph and tone for every action the Worker records', () => {
    const missing = [...workerActions()].filter(([code]) => !ACTIONS[code]);
    expect(missing, 'Add these to ACTIONS (lib/actions.ts)').toEqual([]);
  });

  it('does not show a humanized code for the break-glass, bundle and push key actions', () => {
    for (const code of [
      'auth.breakglass_used',
      'bundle.create',
      'identity.push_key_set',
      'template.version',
    ])
      expect(actionOf(code).label).not.toBe(code.replace(/[._]+/g, ' '));
    expect(actionOf('bundle.rotate_link').label).toBe('Bundle link rotated');
    expect(actionOf('identity.push_key_remove').label).toBe('Push key removed');
  });
});
