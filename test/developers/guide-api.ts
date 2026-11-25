/// <reference types="vite/client" />
import { prefillFromCurl } from '../../src/web/developers/guide/model.ts';
import { parseGuide } from '../../src/web/developers/guide/parse.ts';
import { kit, snippetWorld } from './snippet-world.ts';

const guideText = import.meta.glob<string>('../../docs/developers/guides/*.md', {
  query: '?raw',
  import: 'default',
  eager: true,
});

const curl = import.meta.glob<string>('../../docs/developers/snippets/guides/*.sh', {
  query: '?raw',
  import: 'default',
  eager: true,
});

/** The body of a snippet's curl request: what "Open in console" fills in. */
export function snippetBody(id: string): Record<string, unknown> {
  const text = curl[`../../docs/developers/snippets/guides/${id}.sh`];
  if (!text) throw new Error(`no curl snippet ${id}`);
  return (prefillFromCurl(text, id).body ?? {}) as Record<string, unknown>;
}

/** The JSON body of a guide's `run=<operationId>` fence: the request the guide tells the reader to send. */
export function fence(guideId: string, opId: string): Record<string, unknown> {
  const text = guideText[`../../docs/developers/guides/${guideId}.md`];
  if (!text) throw new Error(`no guide ${guideId}`);
  const block = parseGuide(text, guideId).blocks.find((b) => b.kind === 'code' && b.run === opId);
  if (block?.kind !== 'code') throw new Error(`${guideId}: no run=${opId} fence`);
  return JSON.parse(block.text) as Record<string, unknown>;
}

export interface Answer {
  status: number;
  headers: Headers;
  json: Record<string, any>;
  text: string;
}

/** A sandbox (developer organization, Test key) and a caller that sends what a reader would; `sandbox: false` is a plain organization. */
export async function guideApi({ sandbox = true }: { sandbox?: boolean } = {}) {
  const world = await snippetWorld(await kit(), sandbox ? { kind: 'developer' } : {});
  const call = async (
    method: string,
    path: string,
    body?: unknown,
    headers: Record<string, string> = {},
  ): Promise<Answer> => {
    const url = path.startsWith('http') ? path : `https://passbook.mobile/api/v1${path}`;
    const res = await world.fetch(url, {
      method,
      headers: {
        authorization: `Bearer ${world.secret}`,
        ...(body === undefined ? {} : { 'content-type': 'application/json' }),
        ...(method === 'POST' ? { 'idempotency-key': crypto.randomUUID() } : {}),
        ...headers,
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const text = await res.text();
    let json: Record<string, any> = {};
    try {
      json = JSON.parse(text) as Record<string, any>;
    } catch {
      // A page, not JSON: `text` has it.
    }
    return { status: res.status, headers: res.headers, json, text };
  };
  /** A fresh pass from the issue guide's own request body. */
  const makePass = async (externalId: string) => {
    const body = { ...snippetBody('create-order-pass'), externalId };
    const made = await call('POST', '/passes', body);
    if (made.status !== 201) throw new Error(`create: ${made.status} ${made.text}`);
    return made.json;
  };
  return { world, call, makePass };
}
