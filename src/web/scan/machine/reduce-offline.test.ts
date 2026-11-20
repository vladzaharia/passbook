import { beforeEach, describe, expect, it } from 'vitest';
import { fixtureOutcome, fixtureState } from './fixtures.test-support.ts';
import { at, cmdsOf, readOf, requestKey, resetIds, step } from './reduce.test-support.ts';
import type { Cmd } from './types.ts';

const decideKey = (cmds: Cmd[]) => {
  const [cmd] = cmdsOf(cmds, 'offline.decide');
  if (cmd?.c !== 'offline.decide') throw new Error('no offline.decide');
  return cmd.key;
};

beforeEach(resetIds);

const offlineState = (mode: 'stop' | 'decide' | 'list') =>
  fixtureState({ online: false, offline: { mode, listAt: null, syncing: false } });

describe('a read with no connection (O8)', () => {
  it('Stop answers No connection at once and asks nothing', () => {
    const { state, cmds } = step(offlineState('stop'), readOf('AAAA1111'));
    expect(state.loop).toMatchObject({
      s: 'verdict',
      outcome: { kind: 'system', reason: 'network' },
    });
    expect(cmdsOf(cmds, 'offline.decide')).toEqual([]);
  });

  it.each(['list', 'decide'] as const)('%s hands the read to the offline controller', (mode) => {
    const { state, cmds } = step(offlineState(mode), readOf('AAAA1111'));
    expect(state.loop).toMatchObject({ s: 'checking' });
    expect(cmdsOf(cmds, 'offline.decide')).toEqual([
      {
        c: 'offline.decide',
        key: decideKey(cmds),
        input: expect.objectContaining({ code: 'AAAA1111' }),
      },
    ]);
    expect(cmdsOf(cmds, 'act')).toEqual([]);
  });

  it('a tag still needs a connection', () => {
    const { state } = step(
      offlineState('list'),
      readOf('', { method: 'nfc', tag: { uid: '04AA' } } as never),
    );
    expect(state.loop).toMatchObject({ s: 'verdict', outcome: { kind: 'system' } });
  });

  it('the controller’s verdict lands as the answer, and a queued read is saved', () => {
    const checking = step(offlineState('list'), readOf('AAAA1111'));
    const key = decideKey(checking.cmds);
    const queued = fixtureOutcome('queued', 'saved_offline', { local: true });
    const done = step(checking.state, { type: 'offline', key, outcome: queued }, at(50));
    expect(done.state.loop).toMatchObject({ s: 'verdict', outcome: { kind: 'queued' } });
  });

  it('a failed act while Staff decide is on becomes an offline read under the same key, not an unsure retry', () => {
    const online = fixtureState({ offline: { mode: 'decide', listAt: null, syncing: false } });
    const sent = step(online, readOf('AAAA1111'));
    const key = requestKey(sent.cmds);
    const failed = step(sent.state, { type: 'fail', key, error: 'network' }, at(100));
    expect(cmdsOf(failed.cmds, 'offline.decide')).toEqual([expect.objectContaining({ key })]);
    expect(failed.state.unsure).toEqual([]);
  });

  it('Let in on a Staff decide prompt saves the read as unverified', () => {
    const checking = step(offlineState('decide'), readOf('AAAA1111'));
    const key = decideKey(checking.cmds);
    const ask = step(
      checking.state,
      {
        type: 'offline',
        key,
        outcome: fixtureOutcome('heads_up', 'offline_decide', { local: true }),
      },
      at(50),
    );
    const tapped = step(ask.state, { type: 'override', actionId: 'check_in' }, at(100));
    expect(cmdsOf(tapped.cmds, 'offline.decide')).toEqual([
      expect.objectContaining({ unverified: true }),
    ]);
    expect(tapped.state.loop).toMatchObject({ s: 'checking' });
  });
});
