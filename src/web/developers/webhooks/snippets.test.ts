import { execFileSync, spawnSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';
import vectorFile from '../../../../docs/api/webhook-vectors.json';
import { SDK_STATUS } from '../../../shared/developers-sdk.ts';
import type { WebhookVector } from '../../../shared/webhook-verify.ts';
import { VERIFY_SAMPLES } from './samples.ts';

const vectors = vectorFile.vectors as WebhookVector[];
const sample = (id: string) => VERIFY_SAMPLES.find((s) => s.id === id)?.code ?? '';
const timestamp = (v: WebhookVector) => v.headers['x-passbook-timestamp'] as string;

/** A signature-only vector verifies once the clock is at its own `now`; the others must refuse. */
const verifies = (v: WebhookVector) => v.expect === null;

describe('the verify samples against docs/api/webhook-vectors.json', () => {
  it('lists the five forms of the tester', () => {
    expect(VERIFY_SAMPLES.map((s) => s.label)).toEqual([
      ...(SDK_STATUS.typescript ? ['TypeScript'] : []),
      'Python',
      'Go',
      'Node, no SDK',
      'openssl',
    ]);
  });

  it('Node, no SDK: verifies the valid vectors and refuses the rest', async () => {
    const { createHmac, timingSafeEqual } = await import('node:crypto');
    const src = sample('node')
      .replace(/^import .*$/m, '')
      .replace('export function', 'function');
    const verify = new Function(
      'createHmac',
      'timingSafeEqual',
      'Buffer',
      `${src}\nreturn verify;`,
    )(createHmac, timingSafeEqual, Buffer) as (
      raw: string,
      h: Record<string, string>,
      secret: string,
      now: number,
    ) => boolean;
    for (const v of vectors) {
      // A missing header is a refusal, never a crash.
      const got = v.secrets.some((s) => {
        try {
          return verify(v.body, v.headers, s, v.now);
        } catch {
          return false;
        }
      });
      expect([v.id, got]).toEqual([v.id, verifies(v)]);
    }
  });

  it('openssl: prints the v1 value the server sent', () => {
    if (spawnSync('openssl', ['version']).status !== 0) return;
    for (const v of vectors.filter((x) => x.expect === null)) {
      const out = execFileSync('sh', ['-c', sample('openssl')], {
        env: {
          ...process.env,
          TS: timestamp(v),
          BODY: v.body,
          PASSBOOK_WEBHOOK_SECRET: v.secrets[0],
        },
        encoding: 'utf8',
      }).trim();
      expect(v.headers['x-passbook-signature']).toContain(out);
    }
  });

  it('Python: verifies the valid vectors and refuses the rest', () => {
    if (spawnSync('python3', ['--version']).status !== 0) return;
    const driver = `
import json, sys, time
${sample('py')}
for v in json.load(sys.stdin):
    time.time = lambda now=v["now"]: now
    ok = False
    for s in v["secrets"]:
        try:
            ok = ok or verify(v["body"].encode(), v["headers"], s)
        except KeyError:
            pass
    print(v["id"], ok)
`;
    const out = execFileSync('python3', ['-I', '-c', driver], {
      input: JSON.stringify(vectors),
      encoding: 'utf8',
    });
    const got = Object.fromEntries(
      out
        .trim()
        .split('\n')
        .map((l) => l.split(' ')),
    );
    for (const v of vectors)
      expect([v.id, got[v.id]]).toEqual([v.id, verifies(v) ? 'True' : 'False']);
  });

  it('TypeScript, Python and Go read the raw body, as the page says', () => {
    for (const id of ['py', 'go', ...(SDK_STATUS.typescript ? ['ts'] : [])])
      expect(sample(id)).toMatch(/raw/);
    expect(sample('go')).toContain('hmac.Equal');
    expect(sample('py')).toContain('hmac.compare_digest');
  });
});
