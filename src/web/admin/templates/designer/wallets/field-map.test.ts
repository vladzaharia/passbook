import { describe, expect, it } from 'vitest';
import { samsungCompiler } from '@/passkit/wallets/samsung/index.ts';
import { viewOf } from '@/passkit/wallets/view-fixtures.ts';
import { fieldRows, omitEntryFor } from './field-map.ts';

const NOW = new Date('2026-11-17T10:00:00Z');

describe('field map', () => {
  it('says where each Apple field lands, front to back', async () => {
    const view = await viewOf('starter-store-card');
    const compiled = samsungCompiler.compile(view, { now: NOW, omit: [] });
    const rows = fieldRows(view, compiled, 'samsung', []);
    expect(rows.map((r) => r.path)).toEqual(view.fields.map((f) => f.path));
    const title = view.roles.title?.fields[0];
    const own = rows.find((r) => r.path === title);
    expect(own?.destination).toEqual({ kind: 'own', role: 'title' });
    expect(rows.some((r) => r.destination.kind === 'text')).toBe(true);
  });

  it('marks a field the author left out, by path or by bare key', async () => {
    const view = await viewOf('starter-store-card');
    const compiled = samsungCompiler.compile(view, { now: NOW, omit: ['backFields.terms'] });
    const byPath = fieldRows(view, compiled, 'samsung', ['backFields.terms']);
    expect(byPath.find((r) => r.path === 'backFields.terms')).toMatchObject({
      destination: { kind: 'leftOut' },
      omitEntry: 'backFields.terms',
    });
    const byKey = fieldRows(view, compiled, 'samsung', ['terms']);
    expect(byKey.find((r) => r.key === 'terms')?.omitEntry).toBe('terms');
    expect(omitEntryFor(['terms'], { path: 'backFields.terms', key: 'terms' })).toBe('terms');
  });
});
