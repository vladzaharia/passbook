import { beforeAll, describe, expect, it } from 'vitest';
import { first, run } from '../../platform/db.ts';
import { liveRecipient } from './live-auth.ts';
import { liveRowFor } from './live-render.ts';
import { type SessionLiveFixtures, sessionLiveFixtures } from './session-live-test-fixtures.ts';

let fixtures: SessionLiveFixtures;
beforeAll(async () => {
  fixtures = await sessionLiveFixtures();
});

async function customerIn(name: string, customer: Record<string, unknown>) {
  const { kit, parent, child, pairedAttachment, withSourceProof, row } = fixtures;
  const session = await parent(name);
  const stored = await first<{ settings: string }>(
    kit.env.DB,
    'SELECT settings FROM scanning_sessions WHERE id=?',
    [session.id],
  );
  await run(kit.env.DB, 'UPDATE scanning_sessions SET settings=? WHERE id=?', [
    JSON.stringify({ ...JSON.parse(stored?.settings ?? '{}'), customer }),
    session.id,
  ]);
  const attachment = await pairedAttachment(session.id, `${name} visitor`, 'customer');
  const source = await child(session.id, `${name} scanner`);
  const recipient = await liveRecipient(kit.ctx, attachment);
  if (!recipient) throw new Error('Missing customer recipient.');
  const entry = (more: Partial<ReturnType<typeof row>>) =>
    withSourceProof({ ...row(source.id), ...more });
  return { recipient, entry, source };
}

describe('session customer settings', () => {
  it('reads the session refused line, and falls back to the default', async () => {
    const { kit } = fixtures;
    const custom = await customerIn('Custom refusal', { refusedLine: 'Ask inside' });
    const refused = await custom.entry({ kind: 'refused', label: 'Not accepted' });
    expect((await liveRowFor(kit.ctx, custom.recipient, refused))?.customer?.band.headline).toBe(
      'Ask inside',
    );
    const plain = await customerIn('Plain refusal', {});
    expect(
      (await liveRowFor(kit.ctx, plain.recipient, await plain.entry({ kind: 'heads_up' })))
        ?.customer?.band.headline,
    ).toBe('Please see the desk');
  });

  it('drops the desk card when the session hides it', async () => {
    const { kit } = fixtures;
    const hidden = await customerIn('No ready', { showReady: false });
    expect(
      await liveRowFor(kit.ctx, hidden.recipient, await hidden.entry({ kind: 'ready' })),
    ).toBeNull();
    const shown = await customerIn('Ready', {});
    expect(
      (await liveRowFor(kit.ctx, shown.recipient, await shown.entry({ kind: 'ready' })))?.customer
        ?.screen,
    ).toBe('ready');
  });

  it('never greets without a visible pass, and shows nothing but the band', async () => {
    const { kit } = fixtures;
    const session = await customerIn('Anonymous', { greet: true });
    const body = await liveRowFor(kit.ctx, session.recipient, await session.entry({}));
    expect(body?.customer).toMatchObject({ greet: null, chips: [], panel: null, lines: [] });
    expect(JSON.stringify(body)).not.toContain('Private name');
  });
});
