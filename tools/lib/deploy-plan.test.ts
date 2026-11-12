import { describe, expect, it } from 'vitest';
import {
  deployFlags,
  deployStage,
  missingSecrets,
  pendingMigrations,
  pendingRefusal,
  uploadAndMigrate,
} from './deploy-plan.ts';

describe('deployFlags', () => {
  it('reads argv', () => {
    expect(deployFlags(['--apply', '--secrets'], {})).toEqual(new Set(['--apply', '--secrets']));
  });

  it('refuses a flag npm moved into the environment (given before --)', () => {
    // `npm run deploy --migrate-only -- --apply`: argv holds only --apply.
    expect(() => deployFlags(['--apply'], { npm_config_migrate_only: 'true' })).toThrow(
      'Put deploy flags after --: npm run deploy -- --migrate-only',
    );
    for (const name of ['promote', 'first', 'allow_no_push', 'apply', 'secrets'])
      expect(() => deployFlags([], { [`npm_config_${name}`]: 'true' })).toThrow('after --');
  });

  it('ignores npm config that is not a deploy flag', () => {
    expect(deployFlags(['--promote'], { npm_config_cache: '/x', npm_config_first: '' })).toEqual(
      new Set(['--promote']),
    );
  });
});

describe('missingSecrets', () => {
  it('returns names only', () => {
    const list = JSON.stringify([{ name: 'A', type: 'secret_text' }]);
    expect(missingSecrets(['A', 'B'], list)).toEqual(['B']);
  });
});

describe('deployStage', () => {
  it('runs everything unless a stage is named', () => {
    expect(deployStage(new Set(['--apply']))).toBe('all');
    expect(deployStage(new Set(['--migrate-only']))).toBe('migrate');
    expect(deployStage(new Set(['--promote', '--first']))).toBe('promote');
  });

  it('refuses both stages in one run', () => {
    expect(() => deployStage(new Set(['--migrate-only', '--promote']))).toThrow('separate runs');
  });
});

describe('uploadAndMigrate', () => {
  const steps = (calls: string[], fail?: string, id: string | null = 'v-new') => {
    const step = (name: string) => () => {
      calls.push(name);
      if (fail === name) throw new Error(`${name} failed`);
    };
    return {
      clearVersion: step('clear'),
      upload: () => {
        step('upload')();
        return id;
      },
      bookmark: step('bookmark'),
      migrate: step('migrate'),
      saveVersion: (v: string) => void calls.push(`save ${v}`),
    };
  };

  it('saves the version for --promote only after the migrations apply', () => {
    const calls: string[] = [];
    expect(uploadAndMigrate(steps(calls))).toBe('v-new');
    expect(calls).toEqual(['clear', 'upload', 'bookmark', 'migrate', 'save v-new']);
  });

  it('leaves no version to promote when the upload or a migration fails', () => {
    for (const [fail, ran] of [
      ['migrate', ['clear', 'upload', 'bookmark', 'migrate']],
      ['upload', ['clear', 'upload']],
    ] as const) {
      const calls: string[] = [];
      expect(() => uploadAndMigrate(steps(calls, fail))).toThrow(`${fail} failed`);
      expect(calls).toEqual(ran);
    }
  });

  it('saves nothing with --first (no upload)', () => {
    const calls: string[] = [];
    expect(uploadAndMigrate(steps(calls, undefined, null))).toBeNull();
    expect(calls).toEqual(['clear', 'upload', 'bookmark', 'migrate']);
  });
});

/** `wrangler d1 migrations list wallet-platform --remote`, as wrangler 4 prints it. */
const listed = (...names: string[]) =>
  names.length === 0
    ? '\n ⛅️ wrangler 4.151.1\n───────────────────\n✅ No migrations to apply!\n'
    : `\n ⛅️ wrangler 4.151.1\n───────────────────\nMigrations to be applied:\n┌─${'─'.repeat(30)}┐\n│ Name${' '.repeat(26)}│\n├─${'─'.repeat(30)}┤\n${names
        .map((n) => `│ ${n.padEnd(30)}│`)
        .join('\n')}\n└─${'─'.repeat(30)}┘\n`;

describe('pendingMigrations', () => {
  it('reads the pending files, or none', () => {
    expect(pendingMigrations(listed())).toEqual([]);
    expect(
      pendingMigrations(listed('0025_passes_test_quarantine.sql', '0029_org_memberships.sql')),
    ).toEqual(['0025_passes_test_quarantine.sql', '0029_org_memberships.sql']);
  });

  it('is null for output it does not recognise', () => {
    expect(pendingMigrations('')).toBeNull();
    expect(pendingMigrations('✘ [ERROR] Authentication error [code: 10000]')).toBeNull();
    expect(pendingMigrations('Migrations to be applied:\n(table missing)')).toBeNull();
  });
});

describe('pendingRefusal', () => {
  const cutover = pendingMigrations(
    listed(
      '0025_passes_test_quarantine.sql',
      '0029_org_memberships.sql',
      '0055_attach_without_rotation.sql',
    ),
  );

  it('refuses a full deploy across 0029 on a database with data: the bootstrap must run first', () => {
    expect(pendingRefusal('all', cutover)).toMatch(
      /0029_org_memberships\.sql is pending.*--migrate-only/,
    );
  });

  it('lets a full deploy create an empty database, and run when 0029 is already applied', () => {
    expect(pendingRefusal('all', ['0001_platform.sql', '0029_org_memberships.sql'])).toBeNull();
    expect(pendingRefusal('all', ['0056_next.sql'])).toBeNull();
    expect(pendingRefusal('all', [])).toBeNull();
  });

  it('refuses a promote while any migration is pending, pointing at verify-memberships', () => {
    expect(pendingRefusal('promote', cutover)).toMatch(
      /Not promoting: 3 migration.*verify-memberships/,
    );
    expect(pendingRefusal('promote', ['0056_next.sql'])).toMatch(/Not promoting/);
    expect(pendingRefusal('promote', [])).toBeNull();
  });

  it('fails closed on unreadable wrangler output; --migrate-only does not ask', () => {
    expect(pendingRefusal('all', null)).toMatch(/Could not read/);
    expect(pendingRefusal('promote', null)).toMatch(/Could not read/);
    expect(pendingRefusal('migrate', null)).toBeNull();
  });
});
