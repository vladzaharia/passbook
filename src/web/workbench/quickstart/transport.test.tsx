import { renderHook } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { forgetTokens } from '../host/token.ts';
import { useTransport } from './transport.tsx';

afterEach(() => {
  forgetTokens();
  vi.unstubAllGlobals();
});

const stub = () => {
  const calls: { url: string; headers: Headers }[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      calls.push({ url, headers: new Headers(init?.headers) });
      if (url.endsWith('/workbench/token'))
        return Response.json({
          token: 'pbtry_sbx',
          orgId: 'sbx',
          mode: 'test',
          expiresAt: Date.now() + 900_000,
          subject: 'sandbox_key',
        });
      return Response.json({});
    }),
  );
  return calls;
};

describe('the quickstart transport', () => {
  it('has no token before there is a sandbox: account-level calls ride the session', async () => {
    const calls = stub();
    const { result } = renderHook(() => useTransport(null, 'csrf'));
    expect(result.current.token).toBeNull();
    await result.current.fetch('/api/v1/developer/home', {
      headers: { 'x-passbook-mode': 'live' },
    });
    expect(calls.map((c) => c.url)).toEqual(['/api/v1/developer/home']);
    expect(calls[0]?.headers.get('authorization')).toBeNull();
  });

  it('with a sandbox, every call carries its Workbench token and no mode header', async () => {
    const calls = stub();
    const { result } = renderHook(() => useTransport('sbx', 'csrf'));
    await result.current.fetch('/api/v1/developer/home', {
      headers: { 'x-passbook-mode': 'live', 'x-csrf-token': 'csrf' },
    });
    const home = calls.find((c) => c.url.endsWith('/developer/home'));
    expect(home?.headers.get('authorization')).toBe('Bearer pbtry_sbx');
    expect(home?.headers.get('x-passbook-mode')).toBeNull();
    expect(home?.headers.get('x-csrf-token')).toBe('csrf');
    expect(await result.current.token?.()).toBe('pbtry_sbx');
  });

  it('forget drops the held token, so the next call mints again', async () => {
    const calls = stub();
    const { result } = renderHook(() => useTransport('sbx', 'csrf'));
    await result.current.token?.();
    result.current.forget();
    await result.current.token?.();
    expect(calls.filter((c) => c.url.endsWith('/workbench/token'))).toHaveLength(2);
  });
});
