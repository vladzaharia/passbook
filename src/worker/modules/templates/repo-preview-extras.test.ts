import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { makeEnv } from '../../../../test/helpers/index.ts';
import { run } from '../../platform/db.ts';
import type { AppEnv } from '../../platform/env.ts';
import { listVersionExtras, versionExtrasHash } from './repo-preview-extras.ts';

let env: AppEnv;
let baked: string;
let uploaded: string;

beforeAll(async () => {
  env = await makeEnv();
});

beforeEach(async () => {
  baked = `baked-extra-${crypto.randomUUID()}`;
  uploaded = `uploaded-extra-${crypto.randomUUID()}`;
  for (const [id, origin] of [
    [baked, 'baked'],
    [uploaded, 'uploaded'],
  ] as const) {
    await run(
      env.DB,
      `INSERT INTO templates (id, slug, name, origin, created_at, updated_at)
       VALUES (?, ?, ?, ?, 1, 1)`,
      [id, id, id, origin],
    );
    await run(
      env.DB,
      `INSERT INTO template_versions (template_id, version, manifest, pass_json, created_at)
       VALUES (?, 'v1', '{}', '{}', 1)`,
      [id],
    );
  }
});

const extra = {
  name: 'preview.png',
  size: 1,
  sha1: 'a'.repeat(40),
  sha256: 'b'.repeat(64),
  r2Key: 'preview/key',
};

async function insertExtra(templateId: string, name = extra.name) {
  return run(
    env.DB,
    `INSERT INTO template_version_extras (template_id, version, name, size, sha1, sha256, r2_key)
     VALUES (?, 'v1', ?, ?, ?, ?, ?)`,
    [templateId, name, extra.size, extra.sha1, extra.sha256, extra.r2Key],
  );
}

async function seal(templateId: string, hash: string) {
  return run(
    env.DB,
    `INSERT INTO template_version_extra_sets (template_id, version, extras_hash) VALUES (?, 'v1', ?)`,
    [templateId, hash],
  );
}

describe('versioned preview extras', () => {
  it('accepts only baked sets and requires their immutable seal', async () => {
    await expect(listVersionExtras(env.DB, uploaded, 'v1')).resolves.toEqual([]);
    await expect(listVersionExtras(env.DB, baked, 'v1')).rejects.toThrow('not sealed');
    await expect(insertExtra(uploaded)).rejects.toThrow();
    await expect(seal(uploaded, '0'.repeat(64))).rejects.toThrow();
    await insertExtra(baked);
    await seal(baked, await versionExtrasHash([extra]));
    await expect(listVersionExtras(env.DB, baked, 'v1')).resolves.toEqual([extra]);
  });

  it('does not permit modifying, deleting or extending sealed metadata', async () => {
    await insertExtra(baked);
    await seal(baked, await versionExtrasHash([extra]));
    await expect(insertExtra(baked, 'another.png')).rejects.toThrow();
    await expect(
      run(env.DB, 'UPDATE template_version_extras SET size = 2 WHERE template_id = ?', [baked]),
    ).rejects.toThrow();
    await expect(
      run(env.DB, 'DELETE FROM template_version_extras WHERE template_id = ?', [baked]),
    ).rejects.toThrow();
    await expect(
      run(env.DB, 'UPDATE template_version_extra_sets SET extras_hash = ? WHERE template_id = ?', [
        '0'.repeat(64),
        baked,
      ]),
    ).rejects.toThrow();
    await expect(
      run(env.DB, 'DELETE FROM template_version_extra_sets WHERE template_id = ?', [baked]),
    ).rejects.toThrow();
    await expect(listVersionExtras(env.DB, baked, 'v1')).resolves.toEqual([extra]);
  });

  it('rejects a malformed seal, including for an empty baked set', async () => {
    await seal(baked, '0'.repeat(64));
    await expect(listVersionExtras(env.DB, baked, 'v1')).rejects.toThrow('immutable seal');
  });
});
