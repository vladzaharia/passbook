import { env } from 'cloudflare:workers';
import { describe, expect, it } from 'vitest';
import { run } from '../src/worker/platform/db.ts';

const insert = (slug: string) =>
  run(
    env.DB,
    "INSERT INTO orgs (id, slug, name, status, created_at, updated_at) VALUES (?, ?, 'x', 'active', 1, 1)",
    [`id-${slug}`, slug],
  );

describe('orgs.slug constraint', () => {
  it('rejects slugs with characters outside [a-z0-9-]', async () => {
    for (const bad of ['a B/../x', 'a/b', 'ab_c', 'aB', '-ab', 'a b']) {
      await expect(insert(bad), bad).rejects.toThrow();
    }
  });

  it('accepts plain slugs and rejects invalid updates', async () => {
    await insert('acme-2');
    await expect(
      run(env.DB, "UPDATE orgs SET slug = 'a/../b' WHERE id = ?", ['id-acme-2']),
    ).rejects.toThrow();
    await run(env.DB, "UPDATE orgs SET slug = 'acme-3' WHERE id = ?", ['id-acme-2']);
  });
});
