import { beforeAll, describe, expect, it } from 'vitest';
import { fromBase64 } from '../../platform/ids.ts';
import { captureRuntimeResponse } from './runtime-response.ts';
import {
  BEARER,
  prepareRuntimeTestMaterials,
  runtimeTestFixture,
} from './runtime-test-fixtures.ts';

beforeAll(prepareRuntimeTestMaterials, 30_000);

describe('provider outcome capture', () => {
  it('encrypts exact bounded provider bodies and preserves response status for the adapter', async () => {
    const f = await runtimeTestFixture();
    const responses = await f.encryptedResponseSink();
    const bytes = new Uint8Array(64 * 1024).fill(0x61);
    const replay = await captureRuntimeResponse(
      new Response(bytes as BufferSource, { status: 201 }),
      'google-class',
      'POST',
      responses.onProviderResponse,
    );
    expect(replay.status).toBe(201);
    expect(new Uint8Array(await replay.arrayBuffer())).toEqual(bytes);
    const entries = await responses.readResponses();
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({ stage: 'google-class', method: 'POST', status: 201 });
    expect(fromBase64(entries[0]!.body)).toEqual(bytes);
    expect(JSON.stringify(responses.envelopes)).not.toContain('a'.repeat(100));
  });

  it('captures error bodies and a bodyless response without storing headers', async () => {
    const f = await runtimeTestFixture();
    const responses = await f.encryptedResponseSink();
    const rejected = await captureRuntimeResponse(
      new Response('private provider response', {
        status: 503,
        headers: { authorization: `Bearer ${BEARER}` },
      }),
      'samsung-update',
      'POST',
      responses.onProviderResponse,
    );
    const absent = await captureRuntimeResponse(
      new Response(null, { status: 204 }),
      'samsung-update',
      'POST',
      responses.onProviderResponse,
    );
    expect(await rejected.text()).toBe('private provider response');
    expect(absent.status).toBe(204);
    const entries = await responses.readResponses();
    expect(entries.map(({ status }) => status)).toEqual([503, 204]);
    expect(new TextDecoder().decode(fromBase64(entries[0]!.body))).toBe(
      'private provider response',
    );
    expect(fromBase64(entries[1]!.body)).toHaveLength(0);
    expect(JSON.stringify(entries)).not.toContain(BEARER);
    expect(JSON.stringify(responses.envelopes)).not.toContain('private provider response');
  });

  it('rejects oversize responses without claiming a truncated body is complete', async () => {
    const f = await runtimeTestFixture();
    const responses = await f.encryptedResponseSink();
    const bytes = new Uint8Array(64 * 1024 + 1);
    await expect(
      captureRuntimeResponse(
        new Response(bytes as BufferSource),
        'google-object',
        'PATCH',
        responses.onProviderResponse,
      ),
    ).rejects.toThrow();
    expect(responses.envelopes).toHaveLength(0);
  });
});
