import { randomBytes } from 'node:crypto';
import AxeBuilder from '@axe-core/playwright';
import { type Browser, type BrowserContext, devices, expect, type Page } from '@playwright/test';
import { CompactSign, importPKCS8 } from 'jose';
import { createFixtureIdentity } from '../../src/passkit/testing/fixture-identity.ts';
import { decryptCard } from '../../src/worker/modules/wallet-providers/samsung-card-test-fixtures.ts';
import { BASE } from './api.ts';
import { MOCK } from './wallets.ts';

export const GALAXY_UA =
  'Mozilla/5.0 (Linux; Android 14; SM-S918B) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Mobile Safari/537.36';
export const IPHONE_UA =
  'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1';
export const MAC_UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Safari/605.1.15';

const { defaultBrowserType: _, ...PIXEL } = devices['Pixel 7'];

export type Device = 'pixel' | 'galaxy' | 'iphone' | 'desktop';

/** A holder's browser: the user agent decides which wallet the pass page leads with. */
export async function holderContext(browser: Browser, device: Device): Promise<BrowserContext> {
  if (device === 'desktop')
    return browser.newContext({ viewport: { width: 1280, height: 900 }, userAgent: MAC_UA });
  if (device === 'iphone') return browser.newContext({ ...PIXEL, userAgent: IPHONE_UA });
  return browser.newContext(device === 'galaxy' ? { ...PIXEL, userAgent: GALAXY_UA } : PIXEL);
}

/**
 * A Pixel on which Google's save page is never opened: the save link's JWT goes to the mock's page instead, which
 * records the save (and refuses a JWT whose object it does not hold).
 */
export async function pixelContext(
  browser: Browser,
  passPath: string,
  saves: string[] = [],
): Promise<BrowserContext> {
  const context = await holderContext(browser, 'pixel');
  await context.route(`**${passPath}/wallet/google`, async (route) => {
    const response = await route.fetch({ maxRedirects: 0 });
    const location = response.headers().location ?? '';
    if (response.status() !== 302 || !location.startsWith('https://pay.google.com/gp/v/save/'))
      return route.fulfill({ response });
    saves.push(location);
    return route.fulfill({
      status: 302,
      headers: { location: `${MOCK}${new URL(location).pathname}` },
    });
  });
  return context;
}

/** The holder taps Add to Google Wallet on a Pixel and the mock records the save. */
export async function saveToGoogle(browser: Browser, passPath: string): Promise<void> {
  const context = await pixelContext(browser, passPath);
  try {
    const page = await context.newPage();
    await page.goto(passPath);
    await page.getByRole('link', { name: 'Add to Google Wallet' }).click();
    await expect(page.getByText('Saved to Google Wallet (mock).')).toBeVisible();
  } finally {
    await context.close();
  }
}

export type SamsungCardType = 'loyalty' | 'ticket' | 'coupon';

/**
 * A Samsung partner account against the mock: its card (one partner portal card per type, as storeCard,
 * eventTicket and coupon designs compile to), and the keys Samsung signs its own requests with.
 */
export async function samsungKit(cardType: SamsungCardType, template: Record<string, string> = {}) {
  const [partner, samsung] = await Promise.all([createFixtureIdentity(), createFixtureIdentity()]);
  const partnerId = `e2e${randomBytes(4).toString('hex')}`;
  const certificateId = randomBytes(2).toString('hex').toUpperCase();
  const cardId = `card${randomBytes(6).toString('hex')}`;
  const putCard = (id: string, type: string, over: Record<string, string> = {}) =>
    fetch(`${MOCK}/__mock/samsung-template`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        cardId: id,
        template: { cardType: type, countryCode: 'US', ...template, ...over },
      }),
    });
  const setCard = (over: Record<string, string> = {}) => putCard(cardId, cardType, over);
  await setCard();
  // The credential's default card serves loyalty and generic passes; a ticket or coupon has a card of its own.
  const defaultCardId = cardType === 'loyalty' ? cardId : `${cardId}d`;
  if (defaultCardId !== cardId) await putCard(defaultCardId, 'loyalty');
  const credential = {
    provider: 'samsung' as const,
    partnerId,
    certificateId,
    cardId: defaultCardId,
    ...(defaultCardId === cardId ? {} : { cardIds: { [cardType]: cardId } }),
    partnerPrivateKeyPem: partner.privateKey,
    partnerCertificatePem: partner.certificate,
    samsungCertificatePem: samsung.certificate,
  };

  /** A request Samsung signs with its own key (samsung-token-inbound.ts): the card fetch and the state callback. */
  async function signedCall(refId: string, method: 'GET' | 'POST', query = ''): Promise<Response> {
    const path = `/wallet/v1/samsung/cards/${cardId}/${refId}`;
    const token = await new CompactSign(
      new TextEncoder().encode(JSON.stringify({ API: { method, path } })),
    )
      .setProtectedHeader({
        alg: 'RS256',
        cty: 'AUTH',
        ver: '3',
        partnerId,
        certificateId,
        utc: Date.now(),
      })
      .sign(await importPKCS8(samsung.privateKey, 'RS256'));
    const res = await fetch(`${BASE}${path}${query}`, {
      method,
      headers: {
        authorization: `Bearer ${token}`,
        'x-request-id': randomBytes(8).toString('hex'),
        ...(method === 'POST' ? { 'content-type': 'application/json' } : {}),
      },
      ...(method === 'POST' ? { body: '{}' } : {}),
    });
    return res;
  }
  const asSamsung = async (refId: string, method: 'GET' | 'POST', query = '') =>
    (await signedCall(refId, method, query)).status;

  /** Get Card Data as Samsung reads it: the card JSON, opened with the partner's key. */
  async function card(refId: string): Promise<{
    card: {
      type: string;
      data: { refId: string; state: string; attributes: Record<string, unknown> }[];
    };
  }> {
    const res = await signedCall(refId, 'GET');
    expect(res.status).toBe(200);
    const { cdata } = (await res.json()) as { cdata: string };
    return (await decryptCard(cdata, partner.certificate, samsung.privateKey)) as never;
  }

  /** The badge's redirect chain to Samsung's Add to Wallet page (not followed): the ref Samsung will call back with. */
  async function addLinkRef(passPath: string): Promise<string> {
    const hop = async (url: string) => {
      const res = await fetch(new URL(url, BASE), { redirect: 'manual' });
      expect(res.status).toBe(302);
      return res.headers.get('location') ?? '';
    };
    const wrapper = await hop(`${passPath}/wallet/samsung`);
    expect(wrapper).toMatch(/^\/p\/wallet\/samsung\/[\w-]{43}$/);
    const target = new URL(await hop(wrapper));
    expect(`${target.origin}${target.pathname}`).toBe(
      `https://a.swallet.link/atw/v3/${certificateId}/${cardId}`,
    );
    return /pdata=([A-Za-z0-9_-]{1,32})/.exec(target.hash)?.[1] ?? '';
  }

  /** The holder adds the card: Samsung fetches it (Get Card Data) and reports ADDED. Returns the ref. */
  async function add(passPath: string): Promise<string> {
    const refId = await addLinkRef(passPath);
    expect(refId).not.toBe('');
    expect(await asSamsung(refId, 'GET')).toBe(200);
    expect(await asSamsung(refId, 'POST', '?event=ADDED&cc2=US')).toBe(200);
    return refId;
  }

  return {
    cardId,
    partnerId,
    certificateId,
    credential,
    setCard,
    asSamsung,
    card,
    addLinkRef,
    add,
  };
}

/** The wallets a pass page offers, in the order it shows them (a badge's name is its image's alt text). */
export async function walletOrder(page: Page): Promise<string[]> {
  await page.getByRole('heading', { level: 1 }).waitFor();
  const names = await page
    .locator('main a')
    .evaluateAll((els) =>
      els.map((e) => e.querySelector('img')?.getAttribute('alt') || e.textContent),
    );
  return names
    .map((name) => /^Add to (Apple|Google|Samsung) Wallet$/.exec((name ?? '').trim())?.[1])
    .filter((name): name is string => Boolean(name));
}

/** Serious and critical WCAG violations on the page, as the other a11y specs count them. */
export async function seriousViolations(page: Page) {
  const results = await new AxeBuilder({ page })
    .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'])
    .analyze();
  return results.violations
    .filter((v) => v.impact === 'serious' || v.impact === 'critical')
    .map((v) => ({
      id: v.id,
      help: v.help,
      nodes: v.nodes.slice(0, 3).map((n) => n.target.join(' ')),
    }));
}
