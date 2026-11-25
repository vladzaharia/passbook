import { beforeAll, describe, expect, it } from 'vitest';
import versions from '../../docs/api/versions.json';
import {
  ConnectionError,
  NotFoundError,
  PassBook,
  RateLimitError,
  ServerError,
  ValidationError,
} from '../../sdk/typescript/src/index.ts';
import { SDK_VERSION } from '../../sdk/typescript/src/version.ts';
import { type SdkRig, setupSdkRig } from './sdk-test-kit.ts';

let rig: SdkRig;

beforeAll(async () => {
  rig = await setupSdkRig();
});

const problem = (status: number, code: string, headers: Record<string, string> = {}) =>
  new Response(
    JSON.stringify({ type: `urn:wallet:problem:${code}`, title: 'x', status, code, detail: 'No.' }),
    {
      status,
      headers: { 'content-type': 'application/problem+json', ...headers },
    },
  );

/** Answers the first calls with `first`, in order, then lets the rest through to the app. */
const failing =
  (...first: Array<() => Response | Error>) =>
  (real: typeof fetch): typeof fetch => {
    let n = 0;
    return (input, init) => {
      const next = first[n++];
      if (!next) return real(input, init);
      const out = next();
      return out instanceof Error ? Promise.reject(out) : Promise.resolve(out);
    };
  };

describe('passes in test mode', () => {
  it('creates a test pass, with an Idempotency-Key it can replay', async () => {
    const { pb, calls } = await rig.client();
    const input = { templateId: rig.kit.template.id, input: { memberName: 'Ada Example' } };
    const pass = await pb.passes.create(input, { idempotencyKey: 'sdk-contract-1' });
    expect(pass).toMatchObject({ mode: 'test', status: 'active', title: 'Ada Example' });
    expect(calls[0]?.headers.get('idempotency-key')).toBe('sdk-contract-1');
    expect(calls[0]?.headers.get('authorization')).toMatch(/^Bearer /);

    const again = await pb.passes.create(input, { idempotencyKey: 'sdk-contract-1' });
    expect(again.id).toBe(pass.id);
    expect((await pb.passes.retrieve(pass.id)).id).toBe(pass.id);
  });

  it('sends a fresh key per call by default, and none on a read', async () => {
    const { pb, calls } = await rig.client();
    const body = { templateId: rig.kit.template.id, input: { memberName: 'Auto Key' } };
    const a = await pb.passes.create(body);
    const b = await pb.passes.create(body);
    expect(a.id).not.toBe(b.id);
    expect(calls[0]?.headers.get('idempotency-key')).not.toBe(
      calls[1]?.headers.get('idempotency-key'),
    );
    await pb.passes.retrieve(a.id);
    expect(calls[2]?.headers.has('idempotency-key')).toBe(false);
  });
});

describe('pagination', () => {
  it('walks every page of a list, and exposes pages', async () => {
    const { pb, calls } = await rig.client();
    const made = [];
    for (const name of ['Page A', 'Page B', 'Page C'])
      made.push(
        (await pb.passes.create({ templateId: rig.kit.template.id, input: { memberName: name } }))
          .id,
      );
    calls.length = 0;
    const seen: string[] = [];
    for await (const pass of pb.passes.list({ limit: 2 })) seen.push(pass.id);
    expect(seen).toEqual(expect.arrayContaining(made));
    expect(new Set(seen).size).toBe(seen.length);
    expect(calls.length).toBeGreaterThanOrEqual(2);
    expect(calls[1]?.url).toContain('cursor=');

    const first = await pb.passes.list({ limit: 1 });
    expect(first.items).toHaveLength(1);
    expect(first.nextCursor).toBeTruthy();
    let pages = 0;
    for await (const page of pb.passes.list({ limit: 2 }).pages())
      pages += page.items.length ? 1 : 0;
    expect(pages).toBeGreaterThanOrEqual(2);
  });
});

describe('retries', () => {
  it('retries a 503, a 429 and a network error, reusing the idempotency key', async () => {
    const { pb, calls } = await rig.client({
      through: failing(
        () => problem(503, 'UNAVAILABLE'),
        () => problem(429, 'RATE_LIMITED', { 'retry-after': '0' }),
        () => new TypeError('fetch failed'),
      ),
      maxRetries: 3,
    });
    const pass = await pb.passes.create({
      templateId: rig.kit.template.id,
      input: { memberName: 'Retried' },
    });
    expect(pass.title).toBe('Retried');
    // Three failures never reached the recorder: only the success did.
    expect(calls).toHaveLength(1);
  });

  it('keeps one Idempotency-Key across attempts', async () => {
    const seen: Array<string | null> = [];
    const { pb } = await rig.client({
      through: (real) => (input, init) => {
        seen.push(new Headers(init?.headers).get('idempotency-key'));
        return seen.length < 3 ? Promise.resolve(problem(502, 'UPSTREAM')) : real(input, init);
      },
    });
    await pb.passes.create({ templateId: rig.kit.template.id, input: { memberName: 'Same Key' } });
    expect(seen).toHaveLength(3);
    expect(new Set(seen).size).toBe(1);
    expect(seen[0]).toBeTruthy();
  });

  it('stops at maxRetries and throws the typed error', async () => {
    let calls = 0;
    const { pb } = await rig.client({
      through: () => () => {
        calls++;
        return Promise.resolve(problem(503, 'UNAVAILABLE'));
      },
      maxRetries: 1,
    });
    await expect(pb.passes.retrieve('any')).rejects.toBeInstanceOf(ServerError);
    expect(calls).toBe(2);
  });

  it('does not retry a 4xx, and types it by status with the problem code', async () => {
    const { pb, calls } = await rig.client();
    const error = await pb.passes.retrieve('missing-pass').catch((e: unknown) => e);
    expect(error).toBeInstanceOf(NotFoundError);
    expect(error).toMatchObject({ status: 404, code: expect.any(String) });
    expect((error as NotFoundError).type).toMatch(/^(urn:wallet:problem:|https:\/\/)/);
    expect((error as NotFoundError).docsUrl).toMatch(/^https:\/\/.+\/developers\/errors\//);
    expect(calls).toHaveLength(1);
  });

  it('returns a Retry-After longer than the cap as the error', async () => {
    let calls = 0;
    const { pb } = await rig.client({
      through: () => () => {
        calls++;
        return Promise.resolve(problem(429, 'RATE_LIMITED', { 'retry-after': '3600' }));
      },
    });
    const error = await pb.passes.retrieve('any').catch((e: unknown) => e);
    expect(error).toBeInstanceOf(RateLimitError);
    expect((error as RateLimitError).retryAfter).toBe(3600);
    expect(calls).toBe(1);
  });

  it('does not repeat a write that has no idempotency key after a network error', async () => {
    let calls = 0;
    const { pb } = await rig.client({
      through: () => () => {
        calls++;
        return Promise.reject(new TypeError('fetch failed'));
      },
    });
    // A GET is repeated (1 try and 2 retries); a PATCH with no key may already have run, so it is not.
    await expect(pb.passes.retrieve('x')).rejects.toBeInstanceOf(ConnectionError);
    expect(calls).toBe(3);
    calls = 0;
    await expect(pb.passes.update('x', {} as never)).rejects.toBeInstanceOf(ConnectionError);
    expect(calls).toBe(1);
  });

  it('types a validation failure with its issues', async () => {
    const { pb } = await rig.client();
    const error = await pb.passes.create({} as never).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ValidationError);
    expect((error as ValidationError).status).toBe(422);
    expect((error as ValidationError).issues.length).toBeGreaterThan(0);
  });
});

describe('identity headers', () => {
  const recorder = () => {
    const seen: Headers[] = [];
    const fetch: typeof globalThis.fetch = (_input, init) => {
      seen.push(new Headers(init?.headers));
      return Promise.resolve(
        new Response('{}', { headers: { 'content-type': 'application/json' } }),
      );
    };
    return { seen, fetch };
  };

  it('reports test mode for pb_, pbp_ and pbo_ keys', () => {
    for (const prefix of ['pb', 'pbp', 'pbo'])
      expect(new PassBook({ apiKey: `${prefix}_test_x` }).mode).toBe('test');
    expect(new PassBook({ apiKey: 'pbp_live_x' }).mode).toBe('live');
    expect(new PassBook({ apiKey: 'other' }).mode).toBeUndefined();
  });

  it('sends the SDK User-Agent and the newest API version, which apiVersion overrides', async () => {
    const newest = versions.versions
      .map((v) => v.date)
      .sort()
      .at(-1);
    const { seen, fetch } = recorder();
    await new PassBook({ apiKey: 'pbp_test_x', fetch }).passes.retrieve('p1');
    await new PassBook({ apiKey: 'pbp_test_x', fetch, apiVersion: '2026-01-01' }).passes.retrieve(
      'p1',
    );
    expect(seen[0]?.get('user-agent')).toBe(`passbook-sdk-js/${SDK_VERSION}`);
    expect(seen[0]?.get('passbook-version')).toBe(newest);
    expect(seen[1]?.get('passbook-version')).toBe('2026-01-01');
  });

  it('lets a per-call header replace a default, in any case', async () => {
    const { seen, fetch } = recorder();
    await new PassBook({ apiKey: 'pbp_test_x', fetch }).passes.retrieve('p1', {
      headers: { 'PassBook-Version': '2026-01-01', 'User-Agent': 'call/2' },
    });
    expect(seen[0]?.get('passbook-version')).toBe('2026-01-01');
    expect(seen[0]?.get('user-agent')).toBe('call/2');
  });
});
