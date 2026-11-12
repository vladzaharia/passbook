import { QueryClientProvider } from '@tanstack/react-query';
import { act, renderHook, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { resetModeForTests, setMode } from '../../lib/mode.ts';
import { createQueryClient } from '../../lib/query-client.ts';
import { membershipsQuery, sessionQuery } from '../../lib/session.ts';
import { json, membershipFixture, sessionFixture } from '../../lib/test-utils.tsx';
import {
  canMutatePass,
  passKeys,
  useBulkPassAction,
  usePassActions,
  usePassRemoval,
} from './api.ts';
import { bundleKeys, useBundleActions, useCreateBundle } from './bundle-api.ts';
import { passSummary } from './test-fixtures.ts';

const deferred = Promise as PromiseConstructor & {
  withResolvers<T>(): { promise: Promise<T>; resolve: (value: T) => void };
};

const bundle = {
  id: 'b1',
  orgId: 'org1',
  mode: 'live',
  name: 'Bundle',
  url: 'https://wallet.test/b/token',
  holderEmail: null,
  passes: [],
  createdAt: 1,
  linkRotatedAt: null,
};

afterEach(() => {
  resetModeForTests();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('pass and bundle mutation completion', () => {
  it('rechecks principal, organization, capability, revocation and mode before pass mutations', () => {
    resetModeForTests();
    const client = createQueryClient();
    const session = sessionFixture('admin');
    if (!session.authenticated) throw new Error('Expected an authenticated fixture.');
    const grant = membershipFixture('org1', {
      userId: session.user.id,
      capabilities: ['org:read', 'passes:read', 'passes:operate'],
    });
    const pass = { orgId: 'org1', mode: 'live' as const };
    client.setQueryData(sessionQuery.queryKey, session);
    client.setQueryData(membershipsQuery.queryKey, { items: [grant] });
    expect(canMutatePass(client, pass, session.user.id)).toBe(true);

    client.setQueryData(membershipsQuery.queryKey, {
      items: [{ ...grant, capabilities: ['org:read', 'passes:read'] }],
    });
    expect(canMutatePass(client, pass, session.user.id)).toBe(false);
    client.setQueryData(membershipsQuery.queryKey, { items: [{ ...grant, revokedAt: 1 }] });
    expect(canMutatePass(client, pass, session.user.id)).toBe(false);
    client.setQueryData(membershipsQuery.queryKey, { items: [{ ...grant, orgId: 'org2' }] });
    expect(canMutatePass(client, pass, session.user.id)).toBe(false);
    client.setQueryData(membershipsQuery.queryKey, { items: [grant] });
    setMode('test');
    expect(canMutatePass(client, pass, session.user.id)).toBe(false);
    resetModeForTests();
    const updatedSession: typeof session = { ...session, user: { ...session.user, id: 'u2' } };
    client.setQueryData(sessionQuery.queryKey, updatedSession);
    expect(canMutatePass(client, pass, session.user.id)).toBe(false);
    client.clear();
  });

  it.each([
    'resend',
    'refresh',
    'passDelete',
    'assetDelete',
    'walletRemove',
    'walletRestore',
    'bulkEmail',
    'bundleCreate',
    'bundleSend',
    'bundleRotate',
    'bundleDelete',
  ] as const)('does not change another principal’s caches when %s completes', async (operation) => {
    const client = createQueryClient();
    const session = sessionFixture('admin');
    if (!session.authenticated) throw new Error('Expected an authenticated fixture.');
    client.setQueryData(sessionQuery.queryKey, session);
    const response = deferred.withResolvers<Response>();
    const fetchMock = vi.fn(() => response.promise);
    vi.stubGlobal('fetch', fetchMock);
    const invalidate = vi.spyOn(client, 'invalidateQueries');
    const remove = vi.spyOn(client, 'removeQueries');
    function Wrapper({ children }: { children: ReactNode }) {
      return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
    }
    const { result } = renderHook(
      () => ({
        pass: usePassActions('p1'),
        removal: usePassRemoval('p1'),
        bulk: useBulkPassAction(),
        bundles: useBundleActions('b1', 'live'),
        create: useCreateBundle(),
      }),
      { wrapper: Wrapper },
    );
    let pending!: Promise<unknown>;
    act(() => {
      if (operation === 'resend')
        pending = result.current.pass.resendEmail.mutateAsync({ key: 'k1' });
      else if (operation === 'refresh')
        pending = result.current.pass.refreshFromSource.mutateAsync();
      else if (operation === 'passDelete') pending = result.current.pass.remove.mutateAsync();
      else if (operation === 'assetDelete')
        pending = result.current.pass.removeAsset.mutateAsync('icon.png');
      else if (operation === 'walletRemove')
        pending = result.current.removal.remove.mutateAsync(undefined);
      else if (operation === 'walletRestore')
        pending = result.current.removal.restore.mutateAsync();
      else if (operation === 'bulkEmail') {
        pending = result.current.bulk.mutateAsync({
          action: 'send_email',
          ids: ['p1'],
          orgId: 'org1',
        });
      } else if (operation === 'bundleCreate') {
        pending = result.current.create.mutateAsync({
          orgId: 'org1',
          passIds: ['p1'],
          name: 'Bundle',
        });
      } else if (operation === 'bundleSend')
        pending = result.current.bundles.sendEmail.mutateAsync();
      else if (operation === 'bundleRotate') pending = result.current.bundles.rotate.mutateAsync();
      else pending = result.current.bundles.remove.mutateAsync();
    });
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    act(() => {
      const updatedSession: typeof session = { ...session, user: { ...session.user, id: 'u2' } };
      client.setQueryData(sessionQuery.queryKey, updatedSession);
      client.setQueryData(passKeys.detail('p1'), { owner: 'user-b' });
      client.setQueryData(bundleKeys.all, { owner: 'user-b' });
    });

    const body =
      operation === 'refresh'
        ? { accepted: true, requestedAt: 1 }
        : operation === 'bulkEmail'
          ? { done: 1, skipped: [] }
          : operation === 'bundleCreate' || operation === 'bundleRotate'
            ? bundle
            : operation === 'walletRemove' || operation === 'walletRestore'
              ? passSummary()
              : { ok: true };
    await act(async () => {
      response.resolve(
        operation === 'passDelete' || operation === 'assetDelete' || operation === 'bundleDelete'
          ? new Response(null, { status: 204 })
          : json(body),
      );
      await pending;
    });
    expect(invalidate).not.toHaveBeenCalled();
    expect(remove).not.toHaveBeenCalled();
    expect(client.getQueryData(passKeys.detail('p1'))).toEqual({ owner: 'user-b' });
    expect(client.getQueryData(bundleKeys.all)).toEqual({ owner: 'user-b' });
    client.clear();
  });

  it.each(['resend', 'walletRemove', 'walletRestore'] as const)(
    'refreshes the pass cache for %s when the initiating principal remains active',
    async (operation) => {
      const client = createQueryClient();
      client.setQueryData(sessionQuery.queryKey, sessionFixture('admin'));
      const response = deferred.withResolvers<Response>();
      vi.stubGlobal(
        'fetch',
        vi.fn(() => response.promise),
      );
      const invalidate = vi.spyOn(client, 'invalidateQueries');
      function Wrapper({ children }: { children: ReactNode }) {
        return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
      }
      const { result } = renderHook(
        () => ({ pass: usePassActions('p1'), removal: usePassRemoval('p1') }),
        { wrapper: Wrapper },
      );
      let pending!: Promise<unknown>;
      act(() => {
        if (operation === 'resend')
          pending = result.current.pass.resendEmail.mutateAsync({ key: 'k1' });
        else if (operation === 'walletRemove') {
          pending = result.current.removal.remove.mutateAsync(undefined);
        } else pending = result.current.removal.restore.mutateAsync();
      });
      await act(async () => {
        response.resolve(json(operation === 'resend' ? { ok: true } : passSummary()));
        await pending;
      });
      expect(invalidate).toHaveBeenCalledWith({ queryKey: passKeys.all });
      client.clear();
    },
  );
});
