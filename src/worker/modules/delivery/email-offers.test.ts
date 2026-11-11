import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { first } from '../../platform/db.ts';
import { baseUrl } from '../../platform/env.ts';
import type { rotateLink as RotateLink } from '../passes/pass-service-delivery.ts';
import type { Kit, setupKit as SetupKit } from '../passes/pass-test-fixtures.ts';
import type { listWalletOffers as ListWalletOffers } from '../wallet-providers/offers.ts';
import type { jobCtxOf as JobCtxOf } from './delivery-test-fixtures.ts';
import type { enqueuePassEmail as EnqueuePassEmail } from './issuance-intent.ts';
import type { handleEmailSend as HandleEmailSend } from './jobs.ts';
import type { getOutbox as GetOutbox } from './repo.ts';

let jobCtxOf: typeof JobCtxOf;
const job = () => jobCtxOf(kit);

vi.mock('../wallet-providers/offers.ts', () => ({ listWalletOffers: vi.fn() }));

let kit: Kit;
let lookup: ReturnType<typeof vi.mocked<typeof ListWalletOffers>>;
let rotateLink: typeof RotateLink;
let enqueuePassEmail: typeof EnqueuePassEmail;
let handleEmailSend: typeof HandleEmailSend;
let getOutbox: typeof GetOutbox;
let recipients = 0;

beforeAll(async () => {
  // The setup file already loaded these modules; clearing the cache makes the mock effective, and
  // everything that shares dependency state must come from the same fresh graph.
  vi.resetModules();
  const { setupKit }: { setupKit: typeof SetupKit } = await import(
    '../passes/pass-test-fixtures.ts'
  );
  ({ rotateLink } = await import('../passes/pass-service-delivery.ts'));
  ({ enqueuePassEmail } = await import('./issuance-intent.ts'));
  ({ handleEmailSend } = await import('./jobs.ts'));
  ({ getOutbox } = await import('./repo.ts'));
  ({ jobCtxOf } = await import('./delivery-test-fixtures.ts'));
  const { listWalletOffers } = await import('../wallet-providers/offers.ts');
  lookup = vi.mocked(listWalletOffers);
  kit = await setupKit();
});

beforeEach(() => {
  lookup.mockReset();
});

async function queuePass(mode: 'live' | 'test' = 'live') {
  const pass = await kit.pass({ mode });
  const { outboxId } = await enqueuePassEmail(job(), {
    passId: pass.id,
    to: `wallet-holder-${++recipients}@example.com`,
    attach: false,
    expected: pass,
  });
  return { pass, outboxId };
}

describe('wallet offers in pass delivery', () => {
  it('looks up all offers at delivery and sends only public capability links', async () => {
    const { pass, outboxId } = await queuePass();
    expect(lookup).not.toHaveBeenCalled();
    const returnedOffers = [
      {
        provider: 'google' as const,
        href: `/p/${pass.downloadToken}/wallet/google`,
        installation: 'unknown' as const,
        providerJwt: 'private-google-bearer',
      },
      {
        provider: 'samsung' as const,
        href: `/p/${pass.downloadToken}/wallet/samsung`,
        installation: 'unknown' as const,
        providerToken: 'private-samsung-bearer',
      },
    ];
    lookup.mockResolvedValue(returnedOffers);
    await handleEmailSend({ kind: 'email.send', outboxId }, job());
    expect(lookup).toHaveBeenCalledOnce();
    // Compare only the pass id: matching the context would walk its env bindings (RPC stubs).
    expect(lookup.mock.calls.map((call) => call[1])).toContain(pass.id);
    const sent = kit.mailer.sent.at(-1);
    expect(sent).toBeDefined();
    const base = baseUrl(kit.env);
    for (const provider of ['google', 'samsung']) {
      const link = `${base}/p/${pass.downloadToken}/wallet/${provider}`;
      expect(sent?.html).toContain(`href="${link}"`);
      expect(sent?.text).toContain(link);
    }
    expect(sent?.html).toContain(`href="${base}/p/${pass.downloadToken}/pass.pkpass"`);
    const payload = JSON.stringify((await getOutbox(kit.env.DB, outboxId))?.payload);
    const output = [sent?.html, sent?.text, payload].join('\n');
    expect(payload).not.toContain(pass.downloadToken);
    expect(output).not.toContain('private-google-bearer');
    expect(output).not.toContain('private-samsung-bearer');
  });

  it('keeps Apple only when no native offers are available', async () => {
    const { pass, outboxId } = await queuePass();
    lookup.mockResolvedValue([]);
    await handleEmailSend({ kind: 'email.send', outboxId }, job());
    const sent = kit.mailer.sent.at(-1);
    expect(lookup).toHaveBeenCalledOnce();
    // Compare only the pass id: matching the context would walk its env bindings (RPC stubs).
    expect(lookup.mock.calls.map((call) => call[1])).toContain(pass.id);
    expect(sent?.html).toContain('alt="Add to Apple Wallet"');
    expect(sent?.html).not.toContain('/wallet-providers/');
    expect(sent?.text).not.toContain('Add to Google Wallet');
    expect(sent?.text).not.toContain('Add to Samsung Wallet');
  });

  it('includes available capabilities in test-mode captured mail without sending bearer material', async () => {
    const { pass, outboxId } = await queuePass('test');
    const before = kit.mailer.sent.length;
    const returnedOffers = [
      {
        provider: 'google' as const,
        href: `/p/${pass.downloadToken}/wallet/google`,
        installation: 'unknown' as const,
        providerJwt: 'private-google-bearer',
      },
      {
        provider: 'samsung' as const,
        href: `/p/${pass.downloadToken}/wallet/samsung`,
        installation: 'unknown' as const,
        providerToken: 'private-samsung-bearer',
      },
    ];
    lookup.mockResolvedValue(returnedOffers);
    await handleEmailSend({ kind: 'email.send', outboxId }, job());
    const captured = await first<{ html: string; text: string }>(
      kit.env.DB,
      'SELECT html, text FROM captured_emails WHERE outbox_id = ?',
      [outboxId],
    );
    expect(kit.mailer.sent).toHaveLength(before);
    for (const provider of ['google', 'samsung']) {
      const link = `${baseUrl(kit.env)}/p/${pass.downloadToken}/wallet/${provider}`;
      expect(captured?.html).toContain(`href="${link}"`);
      expect(captured?.text).toContain(link);
    }
    const output = JSON.stringify(captured);
    expect(output).not.toContain('private-google-bearer');
    expect(output).not.toContain('private-samsung-bearer');
  });

  it('cancels rather than sending if the pass link rotates during offer lookup', async () => {
    const { pass, outboxId } = await queuePass();
    const before = kit.mailer.sent.length;
    lookup.mockImplementation(async () => {
      await rotateLink(kit.ctx, { type: 'user', id: 'admin-1' }, pass.id, null);
      return [
        {
          provider: 'google',
          href: `/p/${pass.downloadToken}/wallet/google`,
          installation: 'unknown',
        },
      ];
    });
    await handleEmailSend({ kind: 'email.send', outboxId }, job());
    expect(kit.mailer.sent).toHaveLength(before);
    expect(await getOutbox(kit.env.DB, outboxId)).toMatchObject({
      state: 'cancelled',
      errorCode: 'DELIVERY_STALE',
    });
  });

  it('fails the job without propagating provider secrets if lookup fails', async () => {
    const { outboxId } = await queuePass();
    const before = kit.mailer.sent.length;
    lookup.mockRejectedValue(new Error('private-google-credential'));
    const error: unknown = await handleEmailSend({ kind: 'email.send', outboxId }, job()).catch(
      (caught: unknown) => caught,
    );
    expect(error).toBeInstanceOf(Error);
    expect(String(error)).toBe('Error: Wallet offer lookup failed.');
    expect((error as Error).stack).not.toContain('private-google-credential');
    expect(kit.mailer.sent).toHaveLength(before);
  });
});
