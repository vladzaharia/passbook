import type { SamsungWalletCredentials } from '../../../shared/contracts/wallet-providers.ts';
import type { ServiceContext } from '../../platform/service-context.ts';
import { CERT_WARN_DAYS, type CheckOutcome, DAY_MS } from './account-check-types.ts';
import { providerFetch } from './mock-endpoint.ts';
import { DEFAULT_CARD_TYPE, samsungCardEntries } from './samsung-cards.ts';
import { samsungCredentialWindow, validateSamsungCredentials } from './samsung-credentials.ts';
import { SAMSUNG_REQUEST_TIMEOUT_MS } from './samsung-limits.ts';
import { createSamsungAuthorizationToken } from './samsung-token.ts';

const ORIGIN = 'https://tsapi-card.walletsvc.samsung.com';
const MAX_BODY = 64 * 1024;

function eligible(template: Record<string, unknown>, mode: 'live' | 'test'): boolean {
  const { state, testingModeOff } = template;
  const launched = state === 'ACTIVE' && testingModeOff === 'Y';
  return (
    launched ||
    (mode === 'test' && typeof state === 'string' && state !== 'BLOCKED' && testingModeOff === 'N')
  );
}

/** One card's template: reachable, signed for, this card, and eligible for the mode. */
async function probeCard(
  ctx: ServiceContext,
  account: Awaited<ReturnType<typeof validateSamsungCredentials>>,
  mode: 'live' | 'test',
  cardType: string,
): Promise<string | null> {
  const path = `/partner/v1/card/template/${account.cardId}`;
  const now = ctx.clock.now();
  let response: Response;
  try {
    response = await providerFetch(ctx.env)(`${ORIGIN}${path}`, {
      method: 'GET',
      redirect: 'manual',
      signal: AbortSignal.timeout(SAMSUNG_REQUEST_TIMEOUT_MS),
      headers: {
        Authorization: `Bearer ${await createSamsungAuthorizationToken(account, { method: 'GET', path, now })}`,
        'x-smcs-partner-id': account.partnerId,
        'x-request-id': ctx.ids.id().replaceAll('-', '').slice(0, 32),
      },
    });
  } catch {
    return 'unreachable';
  }
  if (response.status === 401 || response.status === 403) return 'auth_failed';
  if (response.status === 404) return 'card_not_found';
  if (response.status === 429 || response.status >= 500) return 'unreachable';
  if (response.status !== 200) return 'provider_error';
  let page: Record<string, unknown> | null = null;
  try {
    const text = await response.text();
    if (text.length <= MAX_BODY) page = JSON.parse(text) as Record<string, unknown>;
  } catch {
    page = null;
  }
  const template = (page?.template ?? page?.templates) as Record<string, unknown> | undefined;
  if (page?.resultCode !== '0' || !template || typeof template !== 'object')
    return 'provider_error';
  if (template.cardId !== account.cardId) return 'card_not_found';
  // A typed card is a template of its own type; the default card is not tied to one.
  if (cardType !== DEFAULT_CARD_TYPE && template.cardType !== cardType) return 'card_not_found';
  return eligible(template, mode) ? null : 'card_not_active';
}

/**
 * Local key and certificate checks first (expired is its own code), then one template read per card the
 * credential carries. A certificate within 30 days of expiry passes with a warning code.
 */
export async function probeSamsungCards(
  ctx: ServiceContext,
  credentials: SamsungWalletCredentials,
  mode: 'live' | 'test',
): Promise<CheckOutcome> {
  const now = ctx.clock.now();
  let validUntil: number;
  try {
    validUntil = (await samsungCredentialWindow(credentials)).validUntil;
  } catch {
    return { ok: false, code: 'invalid_credentials' };
  }
  if (now >= validUntil) return { ok: false, code: 'cert_expired' };
  for (const [cardType] of samsungCardEntries(credentials)) {
    let account: Awaited<ReturnType<typeof validateSamsungCredentials>>;
    try {
      account = await validateSamsungCredentials(credentials, now, cardType);
    } catch {
      return { ok: false, code: 'invalid_credentials' };
    }
    const failure = await probeCard(ctx, account, mode, cardType);
    if (failure) return { ok: false, code: failure };
  }
  return { ok: true, code: validUntil - now <= CERT_WARN_DAYS * DAY_MS ? 'cert_expiring' : null };
}
