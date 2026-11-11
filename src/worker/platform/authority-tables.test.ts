import { describe, expect, it } from 'vitest';
import { templateSyncGrant } from '../jobs/template-sync.ts';
import { grant, jobGrant } from './authority.ts';
import { codeOf, count } from './authority-ext-fixtures.ts';
import { readPart, writePart } from './authority-include.ts';
import { setupGrant } from './authority-test-fixtures.ts';

const entry = (orgId: string) => ({
  at: 1,
  orgId,
  actorType: 'user',
  actorId: null,
  action: 'tables.audit',
  targetType: null,
  targetId: null,
  requestId: null,
  ipPrefix: null,
  detail: null,
});

describe('GrantInput.tables', () => {
  it('every write method refuses a table outside the list; audit and reads stay allowed', async () => {
    const { s, route, member } = await setupGrant('tb-all');
    const g = grant(route, {
      purpose: 'org_mode.test.tb',
      principal: member(),
      tables: ['pass_events'],
    });
    const refused = (fn: () => unknown) => codeOf(fn);
    expect(
      refused(() => g.update('passes', { set: { display_title: 'x' }, where: { id: s.pass.id } })),
    ).toBe('GRANT_TABLE_NOT_ALLOWED');
    expect(refused(() => g.delete('scans', { where: { id: 'x' } }))).toBe(
      'GRANT_TABLE_NOT_ALLOWED',
    );
    expect(refused(() => g.insertSelect('scans', ['id'], ['x']))).toBe('GRANT_TABLE_NOT_ALLOWED');
    expect(
      refused(() =>
        g.upsert('scan_gates', ['pass_id', 'action_id', 'scope'], ['p', 'a', ''], {
          doNothing: true,
        }),
      ),
    ).toBe('GRANT_TABLE_NOT_ALLOWED');
    expect(
      refused(() =>
        g.joined('scan_event_templates', { where: { template_id: 't' }, delete: true }),
      ),
    ).toBe('GRANT_TABLE_NOT_ALLOWED');
    expect(
      refused(() =>
        g.insertJoined('pass_assets', {
          parents: { pass_id: 'p' },
          columns: ['kind'],
          values: ['x'],
        }),
      ),
    ).toBe('GRANT_TABLE_NOT_ALLOWED');
    expect(
      refused(() =>
        g.include(
          writePart(
            'INSERT INTO counters (key, window_start, count) SELECT ?, 1, 1 WHERE {grant}',
            ['k'],
          ),
        ),
      ),
    ).toBe('GRANT_TABLE_NOT_ALLOWED');
    expect(
      refused(() =>
        g.unguarded(
          'INSERT INTO counters (key, window_start, count) SELECT ?, 1, 1 FROM authority_grants g WHERE g.id = ?',
          ['k', g.id],
        ),
      ),
    ).toBe('GRANT_TABLE_NOT_ALLOWED');
    expect(
      refused(() =>
        g.insertSelect('pass_events', ['pass_id', 'kind', 'data', 'at'], [s.pass.id, 'k', '{}', 1]),
      ),
    ).toBeNull();
    expect(refused(() => g.audit(entry(s.org.id)))).toBeNull();
    expect(refused(() => g.include(readPart('SELECT {org} AS o')))).toBeNull();
    await g.commit();
    expect(await count("SELECT count(*) AS n FROM audit_log WHERE action = 'tables.audit'")).toBe(
      1,
    );
  });

  it('an empty list allows audit only, and a list is carried by job grants', async () => {
    const { s, ctx, route, member } = await setupGrant('tb-empty');
    const none = grant(route, { purpose: 'org_mode.test.tb', principal: member(), tables: [] });
    expect(codeOf(() => none.insertSelect('pass_events', ['pass_id'], ['p']))).toBe(
      'GRANT_TABLE_NOT_ALLOWED',
    );
    expect(codeOf(() => none.audit(entry(s.org.id)))).toBeNull();
    const job = jobGrant(ctx, {
      job: 'x',
      purpose: 'org_mode.job.tb',
      orgId: s.org.id,
      mode: 'live',
      tables: ['counters'],
    });
    expect(
      codeOf(() => job.update('passes', { set: { display_title: 'x' }, where: { id: 'p' } })),
    ).toBe('GRANT_TABLE_NOT_ALLOWED');
    expect(
      codeOf(() =>
        grant(route, { purpose: 'org_mode.test.tb', principal: member(), tables: ['Bad Name'] }),
      ),
    ).toBe('GRANT_BAD_IDENTIFIER');
  });

  it('templateSyncGrant writes the baked sync tables and cannot write passes', async () => {
    const { ctx } = await setupGrant('tb-sync');
    const g = templateSyncGrant(ctx, []);
    expect(
      codeOf(() => g.update('passes', { set: { display_title: 'x' }, where: { id: 'p' } })),
    ).toBe('GRANT_TABLE_NOT_ALLOWED');
    expect(codeOf(() => g.delete('scan_gates', { where: { action_id: 'x' } }))).toBe(
      'GRANT_TABLE_NOT_ALLOWED',
    );
    expect(
      codeOf(() =>
        g.unguarded(
          'DELETE FROM counters WHERE EXISTS (SELECT 1 FROM authority_grants g WHERE g.id = ?)',
          [g.id],
        ),
      ),
    ).toBe('GRANT_TABLE_NOT_ALLOWED');
    expect(
      codeOf(() =>
        g.update('templates', { set: { status: 'archived' }, where: { id: 't', origin: 'baked' } }),
      ),
    ).toBeNull();
    expect(
      codeOf(() =>
        g.upsert('settings', ['scope', 'key', 'value', 'updated_at'], ['system', 'k', 'v', 1], {
          update: ['value'],
        }),
      ),
    ).toBeNull();
    expect(
      codeOf(() =>
        g.unguarded(
          'INSERT INTO template_versions (template_id) SELECT 1 FROM authority_grants g WHERE g.id = ?',
          [g.id],
        ),
      ),
    ).toBeNull();
  });
});
