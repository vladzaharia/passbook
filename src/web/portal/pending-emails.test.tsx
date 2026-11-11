import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { usePendingEmails } from './pending-emails.ts';

beforeEach(() => sessionStorage.clear());
afterEach(() => vi.restoreAllMocks());

describe('usePendingEmails', () => {
  it('recovers and updates pending addresses when the same user returns', () => {
    const first = renderHook(() => usePendingEmails('user-a'));
    act(() => {
      first.result.current.add('a@example.com');
      first.result.current.add('a@example.com');
      first.result.current.add('other@example.com');
    });
    expect(first.result.current.list).toEqual(['a@example.com', 'other@example.com']);
    first.unmount();

    const again = renderHook(() => usePendingEmails('user-a'));
    expect(again.result.current.list).toEqual(['a@example.com', 'other@example.com']);
    act(() => again.result.current.drop(['a@example.com']));
    again.unmount();

    const recovered = renderHook(() => usePendingEmails('user-a'));
    expect(recovered.result.current.list).toEqual(['other@example.com']);
  });

  it('isolates a principal switch and ignores callbacks from the previous user', () => {
    const { result, rerender } = renderHook(
      ({ userId }: { userId: string | undefined }) => usePendingEmails(userId),
      { initialProps: { userId: 'user-a' as string | undefined } },
    );
    act(() => result.current.add('a@example.com'));
    const previous = result.current;

    rerender({ userId: 'user-b' });
    expect(result.current.list).toEqual([]);
    act(() => result.current.add('b@example.com'));
    act(() => {
      previous.add('late@example.com');
      previous.drop(['a@example.com']);
    });
    expect(result.current.list).toEqual(['b@example.com']);
    expect(JSON.parse(sessionStorage.getItem('wallet-pending-emails:user-a') ?? 'null')).toEqual([
      'a@example.com',
    ]);

    rerender({ userId: undefined });
    expect(result.current.list).toEqual([]);
    act(() => result.current.add('anonymous@example.com'));
    expect(result.current.list).toEqual([]);

    rerender({ userId: 'user-a' });
    expect(result.current.list).toEqual(['a@example.com']);
    rerender({ userId: 'user-b' });
    expect(result.current.list).toEqual(['b@example.com']);
  });

  it('discards unowned legacy data rather than attributing it to either account', () => {
    sessionStorage.setItem('wallet-pending-emails', JSON.stringify(['legacy@example.com']));
    const { result, rerender } = renderHook(
      ({ userId }: { userId: string }) => usePendingEmails(userId),
      { initialProps: { userId: 'user-a' } },
    );
    expect(result.current.list).toEqual([]);
    expect(sessionStorage.getItem('wallet-pending-emails')).toBeNull();
    rerender({ userId: 'user-b' });
    expect(result.current.list).toEqual([]);
    expect(sessionStorage.getItem('wallet-pending-emails:user-a')).toBeNull();
    expect(sessionStorage.getItem('wallet-pending-emails:user-b')).toBeNull();
  });

  it('keeps add and cancel usable when storage is blocked', () => {
    const blocked = () => {
      throw new Error('storage blocked');
    };
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(blocked);
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(blocked);
    vi.spyOn(Storage.prototype, 'removeItem').mockImplementation(blocked);
    const { result } = renderHook(() => usePendingEmails('user-a'));
    act(() => result.current.add('a@example.com'));
    expect(result.current.list).toEqual(['a@example.com']);
    act(() => result.current.drop(['a@example.com']));
    expect(result.current.list).toEqual([]);
  });
});
