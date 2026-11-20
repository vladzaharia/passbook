import { describe, expect, it } from 'vitest';
import {
  INITIAL,
  idle,
  landingFocus,
  type OperatorEvent,
  type OperatorState,
  reduceOperator,
  searching,
} from './operator-model.ts';

const play = (...events: OperatorEvent[]): OperatorState => events.reduce(reduceOperator, INITIAL);

describe('operator model', () => {
  it('search replaces the list while the field has text, then gives it back', () => {
    const typed = play({ t: 'query', q: 'mar' });
    expect(searching(typed)).toBe(true);
    const cleared = reduceOperator(typed, { t: 'clear' });
    expect(searching(cleared)).toBe(false);
    expect(cleared.view).toBe('activity');
  });

  it('switching list drops the search and the highlight', () => {
    const s = play(
      { t: 'query', q: 'mar' },
      { t: 'highlight', index: 2 },
      { t: 'view', view: 'problems' },
    );
    expect(s).toMatchObject({ view: 'problems', query: '', highlight: -1 });
  });

  it('the highlight stays inside the results', () => {
    const at = (by: 1 | -1, from: number) =>
      reduceOperator({ ...INITIAL, highlight: from }, { t: 'move', by, count: 3 }).highlight;
    expect(at(1, 0)).toBe(1);
    expect(at(1, 2)).toBe(2);
    expect(at(-1, 0)).toBe(0);
    expect(reduceOperator(INITIAL, { t: 'move', by: 1, count: 0 }).highlight).toBe(-1);
  });

  it('opens one record from any entry, and closes it', () => {
    const opened = play({ t: 'open', ref: { kind: 'pass', passId: 'p1', from: 'problems' } });
    expect(opened.record).toEqual({ kind: 'pass', passId: 'p1', from: 'problems' });
    expect(reduceOperator(opened, { t: 'close' }).record).toBeNull();
  });

  it('closing the record stops previewing the highlighted result', () => {
    const s = play(
      { t: 'query', q: 'mar' },
      { t: 'highlight', index: 1 },
      { t: 'open', ref: { kind: 'pass', passId: 'p', from: 'search' } },
      { t: 'close' },
    );
    expect(s).toMatchObject({ record: null, highlight: -1, query: 'mar' });
  });

  describe('where focus goes when a scan lands', () => {
    it('from idle it goes to the heading', () => {
      expect(idle(INITIAL, false)).toBe(true);
      expect(landingFocus(INITIAL, false)).toBe('heading');
    });
    it('anywhere else the operator keeps their place', () => {
      const open = play({ t: 'open', ref: { kind: 'pass', passId: 'p', from: 'open' } });
      const typing = play({ t: 'query', q: 'mar' });
      expect(landingFocus(open, false)).toBe('stay');
      expect(landingFocus(typing, false)).toBe('stay');
    });
  });
});
