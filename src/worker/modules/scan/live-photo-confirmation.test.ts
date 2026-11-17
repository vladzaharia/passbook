import { runInDurableObject } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import { liveRecipient } from './live-auth.ts';
import { liveRowFor } from './live-render.ts';
import {
  contextWithDb,
  photoFence,
  traceLiveD1,
} from './repo-live-photo-d1-trace-test-fixtures.ts';
import { candidateById } from './repo-lookup.ts';
import { foundOf } from './resolve.ts';
import { hub, kit, photoFixture } from './scan-hub-test-fixtures.ts';

describe('live photo capability disclosure', () => {
  it('keeps the rendered capability out of the candidate, found object and durable event', async () => {
    const fixture = await photoFixture();
    const token = new URL(fixture.path, 'https://wallet.test').searchParams.get('g');
    const candidate = await candidateById(kit.env.DB, kit.org.id, fixture.pass.id);
    if (!candidate || !token) throw new Error('Missing candidate or rendered capability.');
    const found = await foundOf(kit.ctx, candidate);
    if (!found) throw new Error('Missing resolved pass.');
    const sealed = await hub().sourceProof(fixture.event.id);
    if (!sealed) throw new Error('Missing retained source proof.');
    const stored = await runInDurableObject(hub(), async (_object, state) =>
      state.storage.get<unknown[]>('recent'),
    );
    expect(stored).toBeTruthy();
    for (const value of [candidate, found, stored]) {
      expect(JSON.stringify(value)).not.toContain(token);
      expect(JSON.stringify(value)).not.toContain(fixture.path);
    }
    expect(sealed).not.toContain(token);
    const publicRow = (await hub().snapshot(fixture.monitor.attachment)).rows.find(
      (entry) => entry.id === fixture.event.id,
    );
    if (!publicRow?.photoUrl) throw new Error('Missing confirmed live image.');
    expect(publicRow).not.toHaveProperty('sourceProof');
    const currentToken = new URL(publicRow.photoUrl, 'https://wallet.test').searchParams.get('g');
    if (!currentToken) throw new Error('Missing confirmed photo token.');
    expect(JSON.stringify({ ...publicRow, photoUrl: null })).not.toContain(currentToken);
    expect(JSON.stringify(stored)).not.toContain(currentToken);
    for (const secret of [
      fixture.source.token,
      fixture.monitor.token,
      fixture.source.headers['x-csrf-token'],
      fixture.monitor.headers['x-csrf-token'],
    ]) {
      expect(publicRow.photoUrl).not.toContain(secret);
      expect(JSON.stringify(stored)).not.toContain(secret);
    }
    const response = await kit.get(
      fixture.monitor.headers,
      publicRow.photoUrl.replace('/api/v1/scan', ''),
    );
    expect(response.status).toBe(200);
    await response.body?.cancel();
  });

  it.each([
    'missing',
    'photo-missing',
    'photo-empty',
    'photo-not-current',
    'no-marker',
    'failed',
  ] as const)(
    'does not render a URL when the photo fence has a %s confirmation',
    async (damage) => {
      const fixture = await photoFixture();
      const recipient = await liveRecipient(kit.ctx, fixture.monitor.attachment);
      const sourceProof = await hub().sourceProof(fixture.event.id);
      if (!recipient || !sourceProof) throw new Error('Missing live render fixture.');
      let intercepted = false;
      const trace = traceLiveD1(kit.env.DB, (statements, results) => {
        if (!photoFence(statements)) return results;
        intercepted = true;
        const photo = statements.findIndex(({ sql }) => sql.includes('3 AS live_row_kind'));
        if (photo < 0) throw new Error('Missing photo fence statement.');
        if (damage === 'missing') return results.slice(0, -1);
        if (damage === 'photo-missing') return results.filter((_, index) => index !== photo);
        return results.map((result, index) => {
          if (damage === 'photo-empty' && index === photo) return { ...result, results: [] };
          if (damage === 'photo-not-current' && index === photo)
            return { ...result, results: [{ ...(result.results[0] as object), current: 0 }] };
          if (damage === 'no-marker' && index === results.length - 1)
            return { ...result, results: [{ live_render_final: 0 }] };
          if (damage === 'failed' && index === results.length - 1)
            return { ...result, success: false as const };
          return result;
        });
      });
      const internal = { ...fixture.event, sourceProof };
      const rendered = await liveRowFor(contextWithDb(kit.ctx, trace.db), recipient, internal);
      expect(intercepted).toBe(true);
      expect(rendered).toMatchObject({ passId: fixture.pass.id, photoUrl: null });
      expect(rendered).not.toHaveProperty('sourceProof');
    },
  );
});
