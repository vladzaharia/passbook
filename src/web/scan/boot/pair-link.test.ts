import { afterEach, describe, expect, it, vi } from 'vitest';
import { resetPairLink, takePairCode } from './pair-link.ts';

afterEach(resetPairLink);

describe('takePairCode', () => {
  it('reads #pair= once and replaces the history entry with /scan', () => {
    const replaceState = vi.fn();
    const code = takePairCode({ hash: '#pair=ABCD-EFGH-JKLM' }, { replaceState });
    expect(code).toBe('ABCD-EFGH-JKLM');
    expect(replaceState).toHaveBeenCalledTimes(1);
    expect(replaceState).toHaveBeenCalledWith(null, '', '/scan');
  });

  it('returns the same code on a second call (StrictMode) without touching history again', () => {
    const replaceState = vi.fn();
    takePairCode({ hash: '#pair=ABCD' }, { replaceState });
    expect(takePairCode({ hash: '' }, { replaceState })).toBe('ABCD');
    expect(replaceState).toHaveBeenCalledTimes(1);
  });

  it('has no code and leaves history alone when there is no fragment', () => {
    const replaceState = vi.fn();
    expect(takePairCode({ hash: '' }, { replaceState })).toBeNull();
    expect(takePairCode({ hash: '#other=1' }, { replaceState })).toBeNull();
    expect(replaceState).not.toHaveBeenCalled();
  });

  it('strips any fragment that carried a pair key, even a bad code', () => {
    const replaceState = vi.fn();
    expect(takePairCode({ hash: `#pair=${'x'.repeat(200)}` }, { replaceState })).toBeNull();
    expect(replaceState).toHaveBeenCalledWith(null, '', '/scan');
  });
});
