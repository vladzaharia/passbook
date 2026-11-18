import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiError } from '../../lib/errors.ts';
import type { TagsPort } from '../assign/types.ts';
import {
  bindResultOf,
  cardReadEvent,
  inspectOf,
  tagOf,
  tagReadEvent,
} from './assign.test-support.ts';
import { assignOf } from './assign-view.ts';
import { FIXTURE_NOW, states } from './fixtures.test-support.ts';
import { resetIds } from './reduce.test-support.ts';
import { fakeClock, fakeDeps, flush } from './store.test-support.ts';
import { createScanStore } from './store.ts';

beforeEach(resetIds);

function boot(online = true) {
  const clock = fakeClock();
  const fake = fakeDeps(clock);
  const tags = {
    inspect: vi.fn(async () => inspectOf()),
    bind: vi.fn(async (body: { preview?: boolean }) =>
      bindResultOf(body.preview ? {} : { status: 'bound', bindingId: 'b1' }),
    ),
    undo: vi.fn(async () => undefined),
    pending: vi.fn(async () => null),
    complete: vi.fn(async () => ({
      status: 'done' as const,
      hint: 'F7A1',
      scope: 'pass' as const,
      bindingId: 'b2',
    })),
    decline: vi.fn(async () => undefined),
  } satisfies TagsPort;
  const store = createScanStore({ ...fake.deps, tags }, {
    ...states.ready(),
    started: true,
    online,
  } as never);
  return { clock, store, tags, ...fake };
}

describe('tag reads at the door', () => {
  it('goes to the server as a tag input, method nfc, with no code', async () => {
    const { store, api } = boot();
    store.dispatch(tagReadEvent(tagOf('04a2b3c4')));
    expect(api.act).toHaveBeenCalledTimes(1);
    const body = api.act.mock.calls[0]?.[0] as { input: unknown };
    expect(body.input).toEqual({ tag: tagOf('04a2b3c4'), method: 'nfc' });
    await flush();
    expect(store.getSnapshot().state.loop.s).toBe('verdict');
  });

  it('offline is Tag needs a connection, and nothing is sent', () => {
    const { store, api } = boot(false);
    store.dispatch(tagReadEvent());
    expect(api.act).not.toHaveBeenCalled();
    const l = store.getSnapshot().state.loop;
    expect(l.s === 'verdict' && l.outcome).toMatchObject({
      kind: 'system',
      reason: 'tag_offline',
      local: true,
    });
  });

  it('never keeps a timed out tag read on disk', async () => {
    const { store, api, unsure, clock } = boot();
    api.act.mockImplementation(() => new Promise(() => undefined));
    store.dispatch(tagReadEvent());
    clock.advance(6000);
    await flush();
    expect(unsure.rows.size).toBe(0);
  });

  it('the same tag again inside the accepted window is ignored by its signature', async () => {
    const { store, api } = boot();
    store.dispatch(tagReadEvent(tagOf('04a2b3c4D5'.slice(0, 8))));
    await flush();
    const first = api.act.mock.calls.length;
    store.dispatch({ type: 'dismiss' });
    store.dispatch(tagReadEvent(tagOf('04A2B3C4')));
    expect(api.act.mock.calls.length).toBe(first);
  });
});

describe('assign over the ports', () => {
  it('tag, card, preview, bind, undo make the five calls with the keys the machine chose', async () => {
    const { store, tags } = boot();
    store.dispatch({ type: 'assign.open', from: 'menu' });
    store.dispatch(tagReadEvent());
    await flush();
    expect(tags.inspect).toHaveBeenCalledWith({ tag: tagOf() }, expect.anything());
    expect(assignOf(store.getSnapshot().state)?.step).toBe('pass');
    store.dispatch(cardReadEvent());
    await flush();
    expect(tags.bind.mock.calls[0]?.[0]).toMatchObject({ preview: true, binding: 'pass' });
    expect(assignOf(store.getSnapshot().state)?.step).toBe('confirm');
    store.dispatch({ type: 'assign.bind' });
    await flush();
    const bind = tags.bind.mock.calls[1]?.[0] as { idempotencyKey: string; preview: boolean };
    expect(bind.preview).toBe(false);
    expect(bind.idempotencyKey).toMatch(/^0190/);
    expect(assignOf(store.getSnapshot().state)?.step).toBe('done');
    store.dispatch({ type: 'assign.undo' });
    await flush();
    expect(tags.undo).toHaveBeenCalledWith('b1', expect.anything());
    expect(assignOf(store.getSnapshot().state)).toBeNull();
  });

  it("a server code comes back as the machine's failure, and a dropped connection as not assigned", async () => {
    const { store, tags } = boot();
    store.dispatch({ type: 'assign.open', from: 'menu' });
    tags.inspect.mockRejectedValueOnce(new ApiError({ status: 409, code: 'TAG_LOST' }));
    store.dispatch(tagReadEvent());
    await flush();
    expect(assignOf(store.getSnapshot().state)?.error?.kind).toBe('lost');
    store.dispatch({ type: 'assign.again', keepPass: false });
    tags.inspect.mockRejectedValueOnce(new ApiError({ status: 0, code: 'network' }));
    store.dispatch(tagReadEvent(tagOf('11223344')));
    await flush();
    expect(assignOf(store.getSnapshot().state)?.error?.kind).toBe('not_assigned');
  });

  it('an admin request is completed with the tag and declined on Cancel', async () => {
    const { store, tags } = boot();
    store.dispatch({
      type: 'enroll.arrive',
      request: {
        id: '01900000-0000-7000-8000-0000000000bb',
        holderName: 'Maya Okafor',
        passTitle: 'Gym',
        scope: 'pass',
        requestedByName: null,
        expiresAt: FIXTURE_NOW + 90_000,
      },
    });
    store.dispatch(tagReadEvent());
    await flush();
    expect(tags.complete).toHaveBeenCalledWith(
      '01900000-0000-7000-8000-0000000000bb',
      { tag: tagOf() },
      expect.anything(),
    );
    const a = assignOf(store.getSnapshot().state);
    // The device's answer has no card: the done card reads the names off the request.
    expect(a?.step).toBe('done');
    expect(a?.result).toMatchObject({
      bindingId: 'b2',
      hint: 'F7A1',
      card: { holderName: 'Maya Okafor', title: 'Gym' },
    });
  });
});
